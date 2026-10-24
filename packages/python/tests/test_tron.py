from __future__ import annotations

import pytest

from erpc_sdk.tron import TRON_RPC_METHODS, create_tron_client


class _Transport:
    endpoint = "https://tron.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x2b6653dc"


@pytest.mark.asyncio
async def test_tron_keeps_provider_root_and_raw_address_values() -> None:
    transport = _Transport()
    rpc = create_tron_client(transport).rpc
    assert TRON_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_get_balance("0x41abcdef", "latest").send()
    assert transport.last == ("eth_getBalance", ["0x41abcdef", "latest"])
