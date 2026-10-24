from __future__ import annotations

import pytest

from erpc_sdk.hyperliquid import HYPERLIQUID_RPC_METHODS, create_hyperliquid_client


class _Transport:
    endpoint = "https://hyperliquid.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x3e7"


@pytest.mark.asyncio
async def test_hyperliquid_targets_hyperevm_reads_only() -> None:
    transport = _Transport()
    rpc = create_hyperliquid_client(transport).rpc
    assert HYPERLIQUID_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_chain_id().send()
    assert transport.last == ("eth_chainId", [])
    assert not hasattr(rpc, "raw")
