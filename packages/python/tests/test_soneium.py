from __future__ import annotations

import pytest

from erpc_sdk.soneium import SONEIUM_RPC_METHODS, create_soneium_client


class _Transport:
    endpoint = "https://soneium.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x0"


@pytest.mark.asyncio
async def test_soneium_does_not_expose_write_or_generic_methods() -> None:
    transport = _Transport()
    rpc = create_soneium_client(transport).rpc
    assert SONEIUM_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_chain_id().send()
    assert transport.last == ("eth_chainId", [])
    assert not hasattr(rpc, "send_raw_transaction")
    assert not hasattr(rpc, "request")
