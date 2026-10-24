from __future__ import annotations

import pytest

from erpc_sdk.arc import ARC_RPC_METHODS, create_arc_client


class _Transport:
    endpoint = "https://arc.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x1234567890abcdef"


@pytest.mark.asyncio
async def test_arc_preserves_raw_balance_units() -> None:
    transport = _Transport()
    rpc = create_arc_client(transport).rpc
    assert ARC_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    assert await rpc.eth_get_balance("0xabc").send() == "0x1234567890abcdef"
    assert transport.last == ("eth_getBalance", ["0xabc"])
