# ERPC SDK for Rust

Async Rust client for ERPC. The crate covers standard Solana, Ethereum, and
Avalanche C/P/X-chain JSON-RPC, indexed asset and history RPC, leader and analytics
RPC, WebSocket subscriptions, price REST and server-sent events, account usage,
and scoped Cloud reads.

```toml
[dependencies]
erpc-sdk = "0.10"
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

The minimum supported Rust version is 1.85.

This repository guide is maintained separately from the immutable README and
bytes embedded in the already-published `erpc-sdk 0.10.0` crate; editing this
file does not rewrite that artifact. For the non-Rust `0.9.1` cohort, Rust is
verification-only: the carried receipt remains source line
`f05abe4276991612c4b5e404fdc768baace32e61` with SHA-256
`f2ad81528b35470b8f193dc45ad9f95e2d5ba0749b916ab9422cb07639088dd7`.

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
`yoke-derive 0.8.2`; the historical published `erpc-sdk 0.8.0` crate was verified on Rust
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
    let bitcoin_height = erpc.bitcoin.rpc.get_block_count().send().await?;

    println!("slot={slot}, chain_id={chain_id}, avalanche_chain_id={avalanche_chain_id}, bitcoin_height={bitcoin_height}");
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
| `erpc.base.rpc` | Base HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.polygon.rpc` | Polygon PoS mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.bsc.rpc` | BNB Smart Chain mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.optimism.rpc` | OP Mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
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
| `erpc.bitcoin.rpc` | Bitcoin Core HTTP JSON-RPC |
| `erpc.arbitrum.rpc` | Arbitrum One HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.kaia.rpc` | Kaia mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.soneium.rpc` | Soneium mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.monad.rpc` | Monad mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| erpc.hyperliquid.rpc | Hyperliquid HyperEVM mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| erpc.arc.rpc | Arc mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| erpc.robinhood.rpc | Robinhood Chain Public Mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.near.rpc` | NEAR mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.tron.rpc` | TRON mainnet HTTP read-only JSON-RPC (target Rust 0.11.0) |
| `erpc.sui.grpc` | Sui mainnet limited unary binary gRPC-Web reads (target Rust 0.11.0) |
| `erpc.price` | Price metadata, updates, and SSE streams |
| `erpc.account` | Token balance |
| `erpc.usage` | Masked monthly API-key usage |

Most JSON-RPC namespaces expose `request`, `raw`, and `batch` for typed results
and forward-compatible methods. Base, Arbitrum, Polygon, BSC, Optimism, Kaia,
Soneium, Monad, Hyperliquid, Arc, Robinhood, NEAR, and TRON are deliberate
sealed read-only exceptions: each exposes only its approved typed reads and no
raw/request/batch escape hatch. Sui is a separate sealed gRPC-Web namespace
with three limited unary reads and no JSON-RPC or generic protobuf escape
hatch.
Avalanche uses the Ethereum-compatible
typed catalog and defaults to `https://ava-rpc.erpc.global`; the SDK uses its
`/ava` HTTP route and `/ava-ws` WebSocket route. Native namespaces provide
snake_case convenience methods with named parameters, while Index calls use
explicit chain/container paths. Override the base URL with
`ErpcClientConfig::with_avalanche_endpoint` when needed.

## Base read-only RPC (target Rust 0.11.0)

Base support is unreleased source work targeting a separate Rust `0.11.0`
release. The published `erpc-sdk 0.10.0` crate does not contain this namespace;
keep the install line above at `erpc-sdk = "0.10"` until the later promotion
brief and release proof.

The Base façade is HTTP-only and read-only. Hosted calls use the Base root
`https://base.erpc.global/` with the existing `api-key` query authentication.
`with_base_endpoint` selects another hosted root and forwards the configured
ERPC API key through the `api-key` query plus global legacy headers, so the
override must be caller-trusted. A caller-owned endpoint can be selected with
`with_base_rpc`; it preserves the exact path and query, uses only
endpoint-scoped headers, follows no redirects, and works without an ERPC API
key:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_base_rpc(
        RpcEndpointConfig::new("https://base-node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let chain_id = erpc.base.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0x2105");
let balance = erpc
    .base
    .rpc
    .eth_get_balance(["0x1111111111111111111111111111111111111111", "latest"])?
    .send()
    .await?;
let call = erpc
    .base
    .rpc
    .eth_call(serde_json::json!([{
        "to": "0x2222222222222222222222222222222222222222",
        "data": "0x"
    }, "latest"]))?
    .send()
    .await?;
# let _ = (chain_id, balance, call);
# Ok(())
# }
```

The namespace contains exactly `eth_chainId`, `eth_getBalance`, and `eth_call`.
It has no `request`, `raw`, batch, WebSocket/subscription, sign, send,
broadcast, swap, or bridge surface. Results remain wire hex strings; callers
choose their own address and calldata validation and do not route amounts
through floating-point conversions.

For a catalog-backed Base EURC read, use the existing offline token record to
select the contract address, then send a read-only `eth_call`:

```rust,no_run
# use erpc_sdk::{get_token_deployment, tokens, ErpcClient, ErpcClientConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let eurc = get_token_deployment(tokens::base::EURC).expect("catalogued Base EURC");
let eurc_address = eurc.address.expect("Base EURC has an address");
let name = erpc
    .base
    .rpc
    .eth_call(serde_json::json!([{
        "to": eurc_address,
        "data": "0x06fdde03"
    }, "latest"]))?
    .send()
    .await?;
# let _ = name;
# Ok(())
# }
```

## Arbitrum One read-only RPC (target Rust 0.11.0)

Arbitrum support is unreleased source work in the same Rust `0.11.0` candidate
as Base. The published `erpc-sdk 0.10.0` crate does not contain this namespace;
keep the install line above at `erpc-sdk = "0.10"` until the later promotion
brief and release proof. The namespace targets Arbitrum One, whose chain ID is
`42161` (`0xa4b1`), as documented by the [official Arbitrum chain
information](https://docs.arbitrum.io/chain-info).

Hosted calls use the dedicated root `https://arbitrum.erpc.global/` with the
existing `api-key` query authentication. `with_arbitrum_endpoint` can select
an ERPC-compatible hosted override such as
`https://edge.erpc.global/arbitrum`; hosted overrides receive the ERPC API key
and global legacy headers and must be caller-trusted. A caller-owned endpoint
can be selected with `with_arbitrum_rpc`; it preserves the exact path and
query, uses only endpoint-scoped headers, follows no redirects, and works
without an ERPC API key:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_arbitrum_rpc(
        RpcEndpointConfig::new("https://arbitrum-node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let chain_id = erpc.arbitrum.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0xa4b1");
let balance = erpc
    .arbitrum
    .rpc
    .eth_get_balance(["0x1111111111111111111111111111111111111111", "latest"])?
    .send()
    .await?;
let call = erpc
    .arbitrum
    .rpc
    .eth_call(serde_json::json!([{
        "to": "0x2222222222222222222222222222222222222222",
        "data": "0x"
    }, "latest"]))?
    .send()
    .await?;
# let _ = (balance, call);
# Ok(())
# }
```

The façade contains exactly `eth_chainId`, `eth_getBalance`, and `eth_call`.
It has no `request`, `raw`, batch, WebSocket/subscription, sign, send,
broadcast, swap, or bridge surface. For a read-only ERC-20 example, Circle's
[official USDC contract address page](https://developers.circle.com/stablecoins/usdc-contract-addresses)
lists Arbitrum mainnet USDC at
`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`; using it with the
`decimals()` selector `0x313ce567` is caller example input only and does not
add a catalog record or imply bridge support. Verify `eth_chain_id() ==
"0xa4b1"` before trusting any custom endpoint.

## Polygon PoS, BNB Smart Chain, and OP Mainnet read-only RPC (target Rust 0.11.0)

These three namespaces are unreleased source work in the same Rust `0.11.0`
candidate as Base and Arbitrum. The published `erpc-sdk 0.10.0` crate does not
contain them; keep the install line above at `erpc-sdk = "0.10"` until the
later promotion brief and release proof.

The dedicated hosted roots are `https://polygon.erpc.global/`,
`https://bsc.erpc.global/`, and `https://optimism.erpc.global/`. Each uses the
existing `api-key` query authentication and may be overridden with its
corresponding edge façade (`/polygon`, `/bsc`, or `/optimism`). Hosted
overrides receive the ERPC API key and global legacy headers, so they must be
caller-trusted and ERPC-compatible. Caller-owned `with_polygon_rpc`,
`with_bsc_rpc`, and `with_optimism_rpc` endpoints preserve exact paths and
queries, use only scoped headers, follow no redirects, and work keylessly.

| Namespace | Network | Chain ID | Native gas wording |
| --- | --- | --- | --- |
| `erpc.polygon.rpc` | Polygon PoS mainnet | `137` / `0x89` | POL |
| `erpc.bsc.rpc` | BNB Smart Chain mainnet | `56` / `0x38` | BNB |
| `erpc.optimism.rpc` | OP Mainnet | `10` / `0xa` | ETH |

All three expose only `eth_chainId`, `eth_getBalance`, and `eth_call`, each
returning a wire hex `String`. They have no `request`, `raw`, batch,
WebSocket/subscription, sign, send, broadcast, swap, or bridge surface. Verify
`eth_chain_id()` against the expected value before trusting a custom endpoint.
`eth_get_balance` returns a native base-unit quantity; the SDK does not attach
a symbol or perform decimal conversion. Polygon's current native gas wording
is POL, not MATIC.

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let polygon_chain = erpc.polygon.rpc.eth_chain_id().send().await?;
assert_eq!(polygon_chain, "0x89");
let bsc_balance = erpc
    .bsc
    .rpc
    .eth_get_balance(["0x1111111111111111111111111111111111111111", "latest"])?
    .send()
    .await?;
let optimism_call = erpc
    .optimism
    .rpc
    .eth_call(serde_json::json!([{
        "to": "0x2222222222222222222222222222222222222222",
        "data": "0x"
    }, "latest"]))?
    .send()
    .await?;
# let _ = (bsc_balance, optimism_call);
# Ok(())
# }
```

## Kaia, Soneium, and Monad read-only RPC (target Rust 0.11.0)

These three namespaces are unreleased source work in the same Rust 0.11.0
candidate as the earlier sealed EVM facades. The published erpc-sdk 0.10.0
crate does not contain them; keep the install line above at erpc-sdk = 0.10
until the later promotion brief and release proof.

The dedicated hosted roots are https://kaia.erpc.global/,
https://soneium.erpc.global/, and https://monad.erpc.global/. Each uses the
existing api-key query authentication and may be overridden with its edge
facade path (/kaia, /soneium, or /monad). Hosted overrides receive the ERPC
API key and global legacy headers, so they must be caller-trusted and
ERPC-compatible. Caller-owned with_kaia_rpc, with_soneium_rpc, and
with_monad_rpc endpoints preserve exact paths and queries, use only scoped
headers, follow no redirects, and work keylessly.

Network identities and native gas wording:

| Namespace | Network | Chain ID | Native gas wording |
| --- | --- | --- | --- |
| erpc.kaia.rpc | Kaia mainnet | 8217 / 0x2019 | KAIA |
| erpc.soneium.rpc | Soneium mainnet | 1868 / 0x74c | ETH |
| erpc.monad.rpc | Monad mainnet | 143 / 0x8f | MON |

Each facade exposes only eth_chainId, eth_getBalance, and eth_call, returning
wire hex String results. There is no request, raw, batch,
WebSocket/subscription, sign, send, broadcast, swap, or bridge surface. Verify
eth_chain_id() against the expected value before trusting a custom endpoint.
Balances remain raw base-unit quantities: Kaia uses peb, Soneium uses ETH base
units, and Monad uses wei; the SDK performs no amount conversion or
finality/archive assertion. Monad mainnet is 0x8f; Monad Testnet is 0x279f and
is outside this facade. Custom endpoints return their actual chain ID unchanged
so callers can detect a mismatch. Safe/finalized block selectors pass through
as supplied.

## Hyperliquid HyperEVM, Arc, and Robinhood read-only RPC (target Rust 0.11.0)

These three namespaces are unreleased source work in the same Rust 0.11.0
candidate. The published erpc-sdk 0.10.0 crate does not contain them; keep the
install line above at erpc-sdk = 0.10 until the later promotion brief and
release proof.

Hyperliquid is HyperEVM-only. HyperEVM mainnet is chain ID `999` / `0x3e7`.
The exact hosted default is `https://hyperliquid.erpc.global/`, and the exact
edge override is `https://edge.erpc.global/hyperliquid`; the SDK appends neither
`/evm` nor `/nanoreth`. A caller-owned direct target can be configured with
`ErpcClientConfig::for_rpc().with_hyperliquid_rpc(...)`:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_hyperliquid_rpc(
        RpcEndpointConfig::new("https://hyper-node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let chain_id = erpc.hyperliquid.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0x3e7");
# let _ = erpc;
# Ok(())
# }
```

The direct value is the caller-owned complete HTTP(S) request target: it
preserves its path and query, uses scoped headers only, adds no ERPC key or
global headers, and follows no redirects. A custom target's chain ID is
returned unchanged; callers should check `0x3e7` before treating it as
HyperEVM mainnet. The facade never exposes HyperCore info, orders, trades,
exchange, or transfer operations. The default node history caveat is
`latest`-only; caller selectors pass through unchanged and there is no archive
fallback or history promise. Native balances remain raw HYPE quantities.

Arc Mainnet is chain ID `5042` / `0x13b2`, and Arc Testnet is `5042002` /
`0x4cef52`. The exact hosted default is `https://arc.erpc.global/`, and the
exact edge override is `https://edge.erpc.global/arc`. A caller-owned direct
target can be configured with
`ErpcClientConfig::for_rpc().with_arc_rpc(RpcEndpointConfig::new(...))`:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_arc_rpc(
        RpcEndpointConfig::new("https://arc-node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let chain_id = erpc.arc.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0x13b2");
# let _ = erpc;
# Ok(())
# }
```

The direct value is the complete caller-owned HTTP(S) request target: it
preserves its path and query, uses scoped headers only, injects no ERPC key or
global headers, and follows no redirects. A custom target's chain ID is
returned unchanged; callers must verify `0x13b2` before treating it as Arc
Mainnet. Native USDC balances use 18-decimal base units, while the ERC-20 view
uses 6 decimals over the same underlying balance. The SDK returns each raw
view unchanged and performs no conversion, double counting, aggregation, token
registration, wrapper claim, or sentinel mapping.

Robinhood Chain Public Mainnet uses the exact hosted default
`https://robinhood.erpc.global/` and exact edge override
`https://edge.erpc.global/robinhood`. Public Mainnet is chain ID `4663` /
`0x1237`; Robinhood Testnet is `46630` / `0xb626`. A caller-owned direct target
can be configured with
`ErpcClientConfig::for_rpc().with_robinhood_rpc(...)`:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_robinhood_rpc(
        RpcEndpointConfig::new("https://robinhood-node.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let chain_id = erpc.robinhood.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0x1237");
# let _ = erpc;
# Ok(())
# }
```

The direct value is the caller-owned complete HTTP(S) request target: it
preserves its path and query, uses scoped headers only, adds no ERPC key or
global headers, and follows no redirects. A custom target's chain ID is
returned unchanged; callers should check `0x1237` for Public Mainnet and never
relabel `0xb626` as mainnet. This facade is mainnet-only and makes no
brokerage, trading, Stock Token, account, or trading-authentication claim.

All three facades expose only eth_chainId, eth_getBalance, and eth_call,
returning raw hex String results. They have no request, raw, batch,
WebSocket/subscription, sign, send, broadcast, swap, or bridge surface. Verify
the expected chain ID before trusting a custom endpoint. Native balances remain
raw quantities: HyperEVM HYPE, Arc native USDC, and Robinhood native ETH.

## NEAR, TRON, and Sui reads (target Rust 0.11.0)

These three namespaces are unreleased source work targeting the same Rust
`0.11.0` candidate. The published `erpc-sdk 0.10.0` crate does not contain
them; keep the install line above at `erpc-sdk = "0.10"` until a later,
separately approved promotion and release proof. They make no billing, price,
quota, support, or availability promise.

Every new namespace is read-only and exposes origin-only endpoint metadata:
`https://near.erpc.global/`, `https://tron.erpc.global/`, or
`https://sui.erpc.global/` for the dedicated hosted defaults. The reviewed edge
overrides are `https://edge.erpc.global/near`,
`https://edge.erpc.global/tron`, and `https://edge.erpc.global/sui`. The
accessors omit route prefixes, paths, queries, fragments, userinfo, and header
values; an unavailable namespace reports an empty string. Caller-owned direct
configuration uses only its scoped headers and follows no HTTP redirects.

### NEAR HTTP JSON-RPC

`erpc.near.rpc` provides `status`, `block`, and one fixed `view_account` query.
The hosted default is `https://near.erpc.global`; an ERPC-compatible edge
override is `https://edge.erpc.global/near`. A direct configuration preserves
the complete caller-owned URL, including its encoded path and query:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, NearBlockReference, NearFinality,
#     RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let status = erpc.near.rpc.status().send().await?;
assert_eq!(status.chain_id, "mainnet");
let account = erpc.near.rpc.view_account(
    "near",
    NearBlockReference::Finality { finality: NearFinality::Final },
)?.send().await?;
assert!(!account.block_hash.is_empty());

let direct = ErpcClient::new(ErpcClientConfig::for_rpc().with_near_rpc(
    RpcEndpointConfig::new("https://near-node.example/rpc?tenant=customer")
        .with_header("authorization", "Bearer node-token"),
))?;
let _ = direct.near.rpc.status().send().await?;
# Ok(())
# }
```

NEAR account IDs are opaque input strings: named accounts, implicit IDs, and
`0x`/`0s`/`0u` forms are passed through without local grammar or conversion.
`NearBlockReference` is exclusive: choose one `Final` or `Optimistic` finality
selector, or one explicit height or hash. An explicit ID identifies the
requested block and does not imply finality or archival availability; a
pruned-history error is returned without fallback. JSON integer fields remain
`u64`, while gas price, total supply, balances, and other decimal protocol
strings remain exact strings.

`view_account` always sends the named parameters
`{"request_type":"view_account","account_id":...,<one selector>}`. The
transport inherits the established JSON-RPC compatibility behavior: a present
`error` is decoded by the existing strict error path; a `null` or malformed
error is `InvalidResponse`; a valid non-null error maps to the existing RPC
error even with a simultaneous result; `result: null` is invalid for these
non-null projections; and the response `jsonrpc` value is not independently
validated. This documents inherited behavior and is not a claim of full
JSON-RPC envelope validation. The surface has no generic query,
raw/request, batch, subscription, function-call, transaction, signing, or
broadcast operation.

### TRON HTTP JSON-RPC

`erpc.tron.rpc` provides only `eth_chain_id`, `eth_get_balance`, and
read-only `eth_call`. The hosted default is `https://tron.erpc.global`; the
edge override is `https://edge.erpc.global/tron`. The provider maps its hosted
root alias to upstream `/jsonrpc`, so the SDK appends no suffix. A direct URL
is the complete caller-owned target; include `/jsonrpc` when the node requires
it, and the SDK preserves that path and query:

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let chain_id = erpc.tron.rpc.eth_chain_id().send().await?;
assert_eq!(chain_id, "0x2b6653dc");
let balance = erpc.tron.rpc.eth_get_balance([
    "0x1111111111111111111111111111111111111111", "latest",
])?.send().await?;
let call = erpc.tron.rpc.eth_call(serde_json::json!([{
    "to": "0x2222222222222222222222222222222222222222",
    "data": "0x"
}, "latest"]))?.send().await?;

let direct = ErpcClient::new(ErpcClientConfig::for_rpc().with_tron_rpc(
    RpcEndpointConfig::new("https://tron-node.example/jsonrpc?tenant=customer")
        .with_header("authorization", "Bearer node-token"),
))?;
let _ = direct.tron.rpc.eth_chain_id().send().await?;
# let _ = (balance, call);
# Ok(())
# }
```

TRON mainnet is chain ID `728126428` / `0x2b6653dc`; custom or testnet IDs
pass through unchanged. Examples use the documented 20-byte `0x` hexadecimal
addresses. Base58Check and the `41`-prefixed native representation are
different address forms; the SDK performs no conversion or validation and does
not add or remove `41`. `eth_get_balance` returns the raw lowercase `sun`
quantity (`1 TRX = 1,000,000 sun`) without scaling or calling it `wei`.
The typed read contract targets the latest state and makes no archive-history
promise. It has no REST, generic JSON-RPC, batch, WebSocket, transaction,
signing, or broadcast operation.

### Sui binary gRPC-Web

`erpc.sui.grpc` is a separate limited binary gRPC-Web namespace. Its hosted
default is `https://sui.erpc.global`; the edge prefix is
`https://edge.erpc.global/sui`. It supports exactly these case-sensitive unary
paths, with `content-type: application/grpc-web+proto`:

```text
/sui.rpc.v2.LedgerService/GetServiceInfo
/sui.rpc.v2.LedgerService/GetObject
/sui.rpc.v2.StateService/GetBalance
```

`GetServiceInfo` is the identity check. Sui mainnet uses the full Base58
genesis digest `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`; the short
`35834a8a` value is not the gRPC `chain_id`. A direct
`SuiGrpcWebEndpointConfig` value is a compatible endpoint base prefix, not a
complete method target: a path such as `/tenant%2Fone?token=...` remains a
prefix and query while the SDK appends exactly one selected service path. It
does not detect or fall back to native gRPC or legacy Sui JSON-RPC. Hosted
requests use bearer authentication, direct requests use only scoped headers,
and both modes use a no-redirect client.

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, SuiGrpcWebEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(ErpcClientConfig::new("api-key"))?;
let info = erpc.sui.grpc.get_service_info().send().await?;
assert_eq!(info.chain, "mainnet");
assert_eq!(info.chain_id,
    "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S");
let balance = erpc.sui.grpc.get_balance("0xowner", "0x2::sui::SUI")?
    .send().await?;
assert_eq!(balance.balance, balance.address_balance + balance.coin_balance);

let direct = ErpcClient::new(ErpcClientConfig::for_rpc().with_sui_grpc_web(
    SuiGrpcWebEndpointConfig::new("https://sui-node.example/tenant?token=customer")
        .with_header("authorization", "Bearer node-token"),
))?;
let _ = direct.sui.grpc.get_service_info().send().await?;
# Ok(())
# }
```

Balances remain exact `u64` base units. `GetObject` returns only object ID,
version, and digest; `GetBalance` returns the coin type plus total, address,
and coin balances, with their checked sum validated. Inputs are opaque strings
with only non-empty and no-ASCII-control checks. Requests are unary and
read-only: there is no generic protobuf decoder, raw bytes/path escape, field
mask, batch, stream, subscription, transaction, execution, signing, or
broadcast surface.

The adapted Sui schema projection retains its upstream Apache-2.0 provenance;
original SDK source remains MIT. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and the adjacent
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt) for the pinned source and
dependency attribution.

## Bitcoin HTTP JSON-RPC

The Rust client exposes a focused Bitcoin Core HTTP namespace through
`erpc.bitcoin.rpc`. With an ERPC API key, calls use the resolved facade base
with `/bitcoin` appended (the default is `https://edge.erpc.global/bitcoin`),
send `Authorization: Bearer <key>`, and follow no redirects. The namespace is
HTTP-only and has no subscription surface. A caller-owned endpoint is an exact
HTTP(S) target and can be selected without an ERPC key:

Bitcoin HTTP JSON-RPC is Rust-only for this release cohort.

```rust,no_run
# use erpc_sdk::{ErpcClient, ErpcClientConfig, RpcEndpointConfig};
# async fn example() -> erpc_sdk::Result<()> {
let erpc = ErpcClient::new(
    ErpcClientConfig::for_rpc().with_bitcoin_rpc(
        RpcEndpointConfig::new("https://bitcoin.example/rpc?tenant=customer")
            .with_header("authorization", "Bearer node-token"),
    ),
)?;
let block_count = erpc.bitcoin.rpc.get_block_count().send().await?;
# let _ = block_count;
# Ok(())
# }
```

The 12 convenience helpers are `estimate_smart_fee`, `get_best_block_hash`,
`get_block`, `get_blockchain_info`, `get_block_count`, `get_block_hash`,
`get_block_header`, `get_mempool_info`, `get_network_info`, `get_raw_mempool`,
`get_raw_transaction`, and `get_tx_out`. `Value` is used where Bitcoin Core
responses vary by verbosity or version; `get_block_count` uses `u64`, hashes use
`String`, and an absent `gettxout` result is `None`. The SDK enables
`serde_json`'s `arbitrary_precision` feature, so received JSON numbers in
`Value` retain significant digits. Standard numeric normalization is allowed;
for example, `0.00000001` may render as `1e-8` without changing its value.
Exact amount or fee arithmetic belongs to the caller's decimal or base-unit
parser; the SDK never converts these fields through `f64`. Precision starts at
the SDK HTTP response boundary, so an upstream proxy that already parsed and
reserialized a number may have changed its representation.

At SDK JSON network boundaries, objects containing serde's reserved serializer
keys `$serde_json::private::Number` or `$serde_json::private::RawValue` are
rejected before deserialization. This prevents wire objects from being
reinterpreted as numbers or raw JSON. Ordinary objects, strings, and the
`__erpc_sdk_number__` key remain valid; this reserved-key restriction applies
to SDK network responses only.

BTC batches remain one unsplit POST with at most 100 calls, and every request
has one attempt. The raw escape hatch remains server-authoritative and does not
add a local method allowlist or authorize transaction submission.

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

### Optional Mayan Swift v2 bridge (EURC and native USDC)

`MayanSwiftV2BridgeClient` is a separate, explicit client. The published
`erpc-sdk 0.10.0` package includes the reviewed native issued EURC directions:
Ethereum (`deployment-0011`) and Solana (`deployment-0013`), along with the
reviewed native USDC directions, Ethereum (`deployment-0008`) and Solana
(`deployment-0010`). The EURC paths were introduced in the 0.8.x line; this
guide describes the contents of the published 0.10.0 artifact. These are
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

The same request shape accepts the native USDC tuple by using
`deployment-0008` to `deployment-0010` (or the reverse direction). For direct
USDC quotes, `source_swap.required` is `false`, `input_token_deployment_id`
and the intermediate token identify the native source USDC, and
`router_kind`/`router_address` are `null`. These JSON keys remain present.
Rust represents the nullable router fields as `Option<String>`, so consumers
whose source types currently use non-null strings must handle `None` for these
nullable router fields. Existing EURC router values remain unchanged.

### Local unsigned construction (published in 0.10.0)

The published `erpc-sdk 0.10.0` package also exposes `prepare_source_swap` and
`build_local_unsigned` for the reviewed four-route local construction path.
Pass a normalized quote, public source and destination addresses, and a fresh
16-byte public `order_nonce` to preparation, then pass the returned plan to the
local builder with an explicitly configured source-chain RPC:

```rust,no_run
# use erpc_sdk::{
#     MayanSwiftV2BridgeClient, MayanSwiftV2BridgeConfig,
#     MayanSwiftV2LocalBuildConfig, MayanSwiftV2LocalBuildRequest,
#     MayanSwiftV2LocalContext, RpcEndpointConfig,
# };
# async fn example(
#     quote: erpc_sdk::MayanSwiftV2Quote,
#     swapper_address: String,
#     destination_address: String,
#     order_nonce: String,
# ) -> erpc_sdk::BridgeResult<()> {
let bridge = MayanSwiftV2BridgeClient::new(
    MayanSwiftV2BridgeConfig::new().with_local_build(
        MayanSwiftV2LocalBuildConfig::new().with_ethereum_rpc(
            RpcEndpointConfig::new("https://your-ethereum-rpc.example"),
        ),
    ),
)?;
let context = MayanSwiftV2LocalContext {
    quote,
    swapper_address,
    destination_address,
    order_nonce,
};
let source_swap_plan = bridge.prepare_source_swap(context.clone()).await?;
let unsigned = bridge
    .build_local_unsigned(MayanSwiftV2LocalBuildRequest {
        quote: context.quote.clone(),
        swapper_address: context.swapper_address.clone(),
        destination_address: context.destination_address.clone(),
        order_nonce: context.order_nonce.clone(),
        source_swap_plan,
    })
    .await?;
assert_eq!(unsigned.construction.mode, "local");
# Ok(())
# }
```

The matching `solana_rpc` field is required for Solana-source routes. EURC
preparation makes one anonymous request to `source_swap_endpoint`; direct
USDC uses `{ kind: "none" }` and makes no source-swap request. Local builds
perform bounded read-only source RPC checks and construct unsigned EVM or
Solana bytes locally. They never fall back to hosted `/build`, read service or
wallet keys, sign, approve, submit, broadcast, or claim settlement. The
returned public addresses identify the account that an external signer must
authorize; service API keys and RPC headers authenticate services and are not
signer keys. See the [root wallets and signing guidance](https://github.com/elsoul/erpc-sdk/blob/main/README.md#wallets-and-signing)
and the [TypeScript example](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md) for signer and broadcast responsibility.

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
