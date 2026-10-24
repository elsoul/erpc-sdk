from __future__ import annotations

import pytest

from erpc_sdk.robinhood import ROBINHOOD_RPC_METHODS, create_robinhood_client


class _Transport:
    endpoint = "https://robinhood.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x1237"


@pytest.mark.asyncio
async def test_robinhood_means_public_chain_reads() -> None:
    transport = _Transport()
    rpc = create_robinhood_client(transport).rpc
    assert ROBINHOOD_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_chain_id().send()
    assert transport.last == ("eth_chainId", [])
