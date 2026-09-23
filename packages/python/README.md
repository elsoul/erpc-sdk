# ERPC SDK for Python

Async Python client for ERPC. It covers standard Solana, Ethereum, and
Avalanche C/P/X-chain JSON-RPC, indexed assets, history, leader and analytics RPC,
WebSocket subscriptions, price REST and server-sent events, account usage, and
scoped Cloud reads.

```bash
python -m pip install erpc-sdk
```

Python 3.11 or newer is required.

## Quick start

```python
import asyncio
import os

from erpc_sdk import ErpcClient, ErpcClientConfig


async def main() -> None:
    async with ErpcClient(ErpcClientConfig(os.environ["ERPC_API_KEY"])) as erpc:
        slot = await erpc.solana.rpc.get_slot().send()
        chain_id = await erpc.ethereum.rpc.eth_chain_id().send()
        avalanche_chain_id = await erpc.avalanche.rpc.eth_chain_id().send()
        print(slot, chain_id, avalanche_chain_id)


asyncio.run(main())
```

## Direct RPC endpoints (introduced in 0.8.0)

Caller-owned direct endpoint overrides were introduced in `0.8.0` and require
that package when installed from a registry. The published `0.7.0` package
does not include them; check the package version badge and the [latest GitHub
release](https://github.com/elsoul/erpc-sdk/releases/latest) for live
publication status.

Supply a complete HTTP(S) request target for any chain. Its path and query are
sent as provided, without adding an eRPC route or API-key parameter:

Direct requests use that final URL exactly and do not follow redirects.

```python
from erpc_sdk import ErpcClient, ErpcClientConfig, RpcEndpointConfig

config = ErpcClientConfig(
    solana_rpc=RpcEndpointConfig(
        http_url="https://solana.example.test/customer/path?region=eu",
    ),
)
```

Subscriptions use an independent WS(S) target. HTTP headers are scoped to that
chain's direct HTTP endpoint:

```python
config = ErpcClientConfig(
    ethereum_rpc=RpcEndpointConfig(
        http_url="https://ethereum.example.test/rpc",
        websocket_url="wss://ethereum.example.test/stream",
        headers={"Authorization": "Bearer provider-token"},
    ),
)
```

An API key remains optional when at least one direct endpoint is configured;
non-overridden chains and REST services continue to use eRPC when a key is
provided.

## Offline token catalog

The token catalog is bundled with the package, so lookups need no client, API
key, or network request. Deployment IDs are opaque and aliases expose stable
uppercase names:

```python
from erpc_sdk import (
    TokenChainIds,
    find_token_deployments_by_symbol,
    list_token_deployments,
    tokens,
)

ethereum_usdc = find_token_deployments_by_symbol(
    TokenChainIds.ETHEREUM_MAINNET,
    "USDC",
)
canonical_ethereum_usdc_id = tokens.ethereum.USDC
usd_deployments = list_token_deployments(stable_currency="USD")
```

Results include every matching deployment and its status, decimals, standard,
address, and flattened asset metadata. See the [canonical token registry](https://github.com/elsoul/erpc-sdk/blob/main/registry/README.md)
for source records, evidence, and the generation workflow.

## Offline token rankings

Rankings use the same immutable, offline snapshot model:

```python
from erpc_sdk import TokenChainIds, list_token_rankings

ethereum_rankings = list_token_rankings(TokenChainIds.ETHEREUM_MAINNET)
```

The current snapshot is `unconfigured`, so it contains no ranking rows yet.
The schema supports on-chain total-supply value quoted in atomic native units
as a rational value, and licensed global circulating market cap quoted in USD.
The native quote deployment is the chain's native deployment (`deployment-0001`
on Ethereum, `deployment-0003` on Avalanche C, and `deployment-0005` on
Solana); these values are not circulating market caps. Unknown or empty chain
IDs return an immutable empty tuple. Ranking collection automation is not
active yet.

## Offline DEX catalog and RPC quotes

DEX deployments, pools, native-to-wrapped relationships, and chain-qualified
aliases are bundled in the package as immutable generated data. The six
lookups are network-free:

```python
from erpc_sdk import (
    DexChainIds,
    find_pool_definitions_by_pair,
    get_native_wrap_definition,
    list_pool_definitions,
    pools,
)

eth_pools = list_pool_definitions({"chainId": DexChainIds.ETHEREUM_MAINNET})
pair = find_pool_definitions_by_pair(
    DexChainIds.ETHEREUM_MAINNET,
    "deployment-0002",  # WETH
    "deployment-0008",  # USDC
)
weth = get_native_wrap_definition("deployment-0001")
pool_id = pools.ethereum.UNISWAP_V2_USDC_WETH
```

The quote client reads the selected EVM V2 pool directly through the
configured ERPC JSON-RPC transport. It performs an exact-input quote from a
single canonical block snapshot, with no hosted router or market-data API:

```python
quote = await erpc.swap.quote_exact_input({
    "chainId": DexChainIds.ETHEREUM_MAINNET,
    "poolDefinitionId": pool_id,
    "inputTokenDeploymentId": "deployment-0002",  # WETH
    "outputTokenDeploymentId": "deployment-0008",  # USDC
    "amountIn": "1000000000000000000",
})
print(quote["amountOut"])
```

The `0.7.0` catalog supports quotes for the Ethereum Uniswap V2 and
Avalanche LFJ legacy constant-product pools. Solana Orca and Raydium records
are available for lookup while their CLMM quote adapters are being added.
Newly discovered pools remain available for lookup, monitoring, and rankings
until a reviewed quote capability is admitted.
The DEX catalog and swap exports are included in the published `0.7.0` package;
unsigned EVM preparation and simulation below were introduced in `0.8.0` and
require that package.

The two reviewed EVM pools also support unsigned ERC-20 exact-input
preparation and read-only RPC simulation:

```python
import time

request = {
    "chainId": DexChainIds.ETHEREUM_MAINNET,
    "poolDefinitionId": "pool-0001",
    "inputTokenDeploymentId": "deployment-0002",  # WETH
    "outputTokenDeploymentId": "deployment-0008",  # USDC
    "amountIn": "1000000000000000000",
    "sender": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "recipient": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "slippageBps": 50,
    "deadline": str(int(time.time())+300),
}

prepared = await erpc.swap.prepare_exact_input_swap(request)
simulation = await erpc.swap.simulate_exact_input_swap(request)
```

Preparation performs a fresh quote and validates the reviewed router at the
same canonical block. It returns an unsigned transaction envelope and an
allowance description; it does not create approval calldata, sign, send, or
fill wallet-specific nonce and fee fields. The envelope uses the canonical
CAIP-2 chain ID, so convert it explicitly when passing fields to a wallet API:

```python
transaction = prepared["transaction"]
wallet_transaction = {
    key: transaction[key] for key in ("from", "to", "data", "value")
}
```

The simulation result reports the canonical allowance and router amounts. The
caller wallet controls allowance changes, signing, and broadcasting.

## Wallets and signing

The Python SDK has no `wallet`, `private_key`, or `signer` configuration and
never loads wallet keys or signs locally. `sender`, `from`, `swapperAddress`,
and `feePayer` are public addresses; ERPC API keys, direct-RPC headers, and
the Mayan `builder_api_key` authenticate services and are not signing keys.
Swap preparation and `build_unsigned` return unsigned envelopes. The
application-owned wallet or hardware signer signs them, then the caller sends
serialized signed bytes through
`erpc.ethereum.rpc.eth_send_raw_transaction(...).send()` or
`erpc.solana.rpc.send_transaction(...).send()`. Approval policy, chain and
fee selection, transaction review, and confirmation remain with the caller.

See the [common wallets and signing guidance](https://github.com/elsoul/erpc-sdk/blob/main/README.md#wallets-and-signing)
and the [TypeScript signing and broadcast guide](https://github.com/elsoul/erpc-sdk/blob/main/packages/typescript/docs/signing-and-broadcast.md)
for initialized external-signer examples.

## Optional Mayan Swift v2 bridge (EURC in 0.8.0)

The released `0.8.0` API includes the standalone bridge adapter for the reviewed
native EURC routes between Ethereum and Solana. It uses Mayan's configured quote, transaction-builder,
source-swap, solver, relayer, Wormhole, and Explorer services; normal ERPC
configuration, keys, and headers are never forwarded to those services.

```python
from erpc_sdk import MayanSwiftV2BridgeConfig, create_mayan_swift_v2_bridge_client

quote_bridge = create_mayan_swift_v2_bridge_client(
    MayanSwiftV2BridgeConfig(
        builder_endpoint="https://tx-builder.mayan.finance",
        explorer_endpoint="https://explorer-api.mayan.finance/v3",
    )
)
quote = (
    await quote_bridge.quote_exact_input(
        {
            "sourceChainId": "eip155:1",
            "destinationChainId": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "sourceTokenDeploymentId": "deployment-0011",
            "destinationTokenDeploymentId": "deployment-0013",
            "amountIn": "100000000",
            "slippageBps": 50,
        }
    )
)[0]
await quote_bridge.close()

build_bridge = create_mayan_swift_v2_bridge_client(
    MayanSwiftV2BridgeConfig(
        builder_endpoint="https://tx-builder.mayan.finance",
        explorer_endpoint="https://explorer-api.mayan.finance/v3",
        builder_api_key="provider-key",
    )
)
unsigned = await build_bridge.build_unsigned(
    {
        "quote": quote,
        "swapperAddress": "0x2222222222222222222222222222222222222222",
        "destinationAddress": "So11111111111111111111111111111111111111112",
    }
)
await build_bridge.close()
```

Builds are unsigned and structurally checked. The adapter does not sign,
approve, broadcast, submit, cancel, refund, or locally verify provider
signatures, transaction semantics, or settlement. Builds without a provider
key require the explicit `allow_unauthenticated_build=True` configuration.
The default builder endpoint is `https://tx-builder.mayan.finance` for
quote/build and the default Explorer endpoint is
`https://explorer-api.mayan.finance/v3` for indexed status; set
`builder_endpoint` and `explorer_endpoint` to customize them. The
`builder_api_key` is a separate Mayan build-only key and is never an ERPC
credential. Mayan's [official quote API documentation](https://docs.mayan.finance/integration/quote-api#api-key)
and the pinned [transaction-builder authentication documentation](https://github.com/mayan-finance/tx-builder/blob/e966f16a155cd9091b02ef5d9b91c3f837c228ad/README.md#authentication)
describe the provider key as optional. The Python SDK has a separate local
guard: `build_unsigned` requires `builder_api_key` by default, while
`allow_unauthenticated_build=True` explicitly permits a keyless HTTP attempt
at the configured endpoint, including the default endpoint. That opt-in does
not guarantee provider permission. Quote and Explorer calls do not receive
the Mayan key or an ERPC credential.

A bounded recheck at `2026-09-17T11:27:34Z` observed HTTP 200 for all four
EURC/USDC quote directions. Default builds made no network call because the
local guard stopped them; explicit anonymous builds reached `/build` and each
returned HTTP 401 `UNAUTHORIZED`. The provider deployment revision was
unknown, so this observation does not establish a universal or permanent key
requirement. No authenticated build or settlement evidence was captured.

Native USDC Ethereum mainnet and Solana mainnet directions are an unreleased
source addition in this tree. They use direct Swift bridging with
`sourceSwap.required` set to `False`, null router fields, and no Jupiter or
0x source-swap dependency. Do not rely on USDC support from a published
`0.8.0` wheel until a release explicitly includes this addition. The bridge
adapter remains separate from the RPC-only swap helpers.

### Local unsigned construction

`prepare_source_swap` and `build_local_unsigned` are explicit local operations
for the same four reviewed routes. Preparation returns a hash-bound source
swap plan; direct USDC returns `{ "kind": "none" }` without source-swap I/O.
Local builds require a matching caller-configured `ethereum_rpc` or
`solana_rpc` endpoint under `local_build` and use read-only chain/code or
blockhash/lookup-table checks. There is no public-RPC fallback and no fallback
to Mayan `/build`; configured RPC headers stay on that RPC and never flow to
Mayan source-swap requests.

Local builds return unsigned transaction bytes with structural construction
evidence. The SDK does not create keys, load wallet secrets, sign, approve,
submit, broadcast, or claim provider-signature or settlement verification.

### Local unsigned construction

`prepare_source_swap` and `build_local_unsigned` are explicit local operations
for the same four reviewed routes. Preparation returns a hash-bound source
swap plan; direct USDC returns `{ "kind": "none" }` without source-swap I/O.
Local builds require a matching caller-configured `ethereum_rpc` or
`solana_rpc` endpoint under `local_build` and use read-only chain/code or
blockhash/lookup-table checks. There is no public-RPC fallback and no fallback
to Mayan `/build`; configured RPC headers stay on that RPC and never flow to
Mayan source-swap requests.

Local builds return unsigned transaction bytes with structural construction
evidence. The SDK does not create keys, load wallet secrets, sign, approve,
submit, broadcast, or claim provider-signature or settlement verification.

Both exact wire names (`getSlot`, `eth_chainId`) and Python snake-case aliases
(`get_slot`, `eth_chain_id`) create inert requests. Network I/O starts only
when `send()` is awaited. `request()` restricts calls to the namespace catalog;
`raw()` is the forward-compatible escape hatch.

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

`avalanche_endpoint` defaults to `https://ava-rpc.erpc.global` and can be
overridden independently. The SDK uses its `/ava` HTTP route and `/ava-ws`
WebSocket route. Native methods use named mappings and Index calls use explicit
chain/container paths. Native and Index batches are rejected locally; use
`raw()` with an exact wire method name for forward compatibility.

```python
p_height = await erpc.avalanche.p_chain.get_height().send()
indexed_tx = await erpc.avalanche.index.x_chain_transactions.get_container_by_id(
    {"id": transaction_id}
).send()
```

## Intact batches

```python
results = await erpc.solana.rpc.batch([
    {"method": "getSlot", "params": []},
    {"method": "getBlockHeight", "params": []},
]).send()
```

The SDK sends one caller batch as one server batch, restores caller order,
accepts at most 256 calls, and rejects invalid mixed or unsupported batches
locally. It never silently splits a batch.

## Subscriptions

```python
subscription = await erpc.ethereum.subscriptions.subscribe("newHeads")
async for header in subscription:
    print(header)
    await subscription.unsubscribe()
    break
```

Solana exposes `account_subscribe`, `transaction_subscribe`, and
`raw_subscribe`. HTTP requests accept a `RequestOptions(cancel_event=...)`;
normal asyncio task cancellation is also preserved.

## Cloud reads

```python
from erpc_sdk import ErpcCloudClient, ErpcCloudClientConfig

async with ErpcCloudClient(ErpcCloudClientConfig(access_token)) as cloud:
    offerings = await cloud.catalog.list()
    resources = await cloud.resources.list()
```

Cloud configuration accepts HTTPS endpoints and localhost HTTP endpoints for
testing. It retains only the access token supplied by the caller and does not
implement interactive authorization or refresh-credential storage.

## Safety boundaries

- Credentials are redacted from configuration representations, public
  endpoints, transport errors, and JSON-RPC error data.
- State-changing calls, including transaction submission, are never retried.
- REST, JSON-RPC, and caller batch boundaries remain explicit.
- Unknown methods remain available through `raw()` without being included in
  the typed compatibility catalog.
