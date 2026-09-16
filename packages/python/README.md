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

## Direct RPC endpoints

This section documents unreleased source-checkout work; direct RPC endpoint
overrides are not included in the published 0.7.0 package.

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

The first catalog release supports quotes for the Ethereum Uniswap V2 and
Avalanche LFJ legacy constant-product pools. Solana Orca and Raydium records
are available for lookup while their CLMM quote adapters are being added.
Newly discovered pools remain available for lookup, monitoring, and rankings
until a reviewed quote capability is admitted.
The DEX catalog and swap exports are included in the published 0.7.0 package.

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
