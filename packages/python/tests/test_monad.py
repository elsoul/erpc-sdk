from __future__ import annotations

import pytest

from erpc_sdk.monad import MONAD_RPC_METHODS, create_monad_client


class _Transport:
    endpoint = "https://monad.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x8f"


@pytest.mark.asyncio
async def test_monad_is_mainnet_sealed_read_surface() -> None:
    transport = _Transport()
    rpc = create_monad_client(transport).rpc
    assert MONAD_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_get_balance("0xabc").send()
    assert transport.last == ("eth_getBalance", ["0xabc"])
