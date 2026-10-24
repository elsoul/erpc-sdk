from __future__ import annotations

import pytest

from erpc_sdk.bsc import BSC_RPC_METHODS, create_bsc_client


class _Transport:
    endpoint = "https://bsc.example/"

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.last = (method, params)
        return "0x38"


@pytest.mark.asyncio
async def test_bsc_sealed_surface_has_no_generic_escape_hatch() -> None:
    transport = _Transport()
    rpc = create_bsc_client(transport).rpc
    assert BSC_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    await rpc.eth_get_balance("0xabc").send()
    assert transport.last == ("eth_getBalance", ["0xabc"])
    assert not hasattr(rpc, "request")
    assert not hasattr(rpc, "batch")
