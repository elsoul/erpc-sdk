# ERPC SDK for Python

Async Python client for ERPC. It covers standard Solana and Ethereum JSON-RPC,
indexed assets, history, leader and analytics RPC, WebSocket subscriptions,
price REST and server-sent events, account usage, and scoped Cloud reads.

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
        print(slot, chain_id)


asyncio.run(main())
```

Both exact wire names (`getSlot`, `eth_chainId`) and Python snake-case aliases
(`get_slot`, `eth_chain_id`) create inert requests. Network I/O starts only
when `send()` is awaited. `request()` restricts calls to the namespace catalog;
`raw()` is the forward-compatible escape hatch.

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
