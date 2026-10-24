from __future__ import annotations

import pytest

from erpc_sdk.optimism import OPTIMISM_RPC_METHODS, create_optimism_client


class _Transport:
    endpoint = "https://optimism.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0xa"


@pytest.mark.asyncio
async def test_optimism_keeps_raw_hex_and_call_shape() -> None:
    transport = _Transport()
    rpc = create_optimism_client(transport).rpc
    assert OPTIMISM_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    assert await rpc.eth_chain_id().send() == "0xa"
    await rpc.eth_call({"to": "0xabc"}, "safe", {"state": "0x1"}).send()
    assert transport.last == ("eth_call", [{"to": "0xabc"}, "safe", {"state": "0x1"}])
