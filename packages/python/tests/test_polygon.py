from __future__ import annotations

import pytest

from erpc_sdk.polygon import POLYGON_RPC_METHODS, create_polygon_client


class _Transport:
    endpoint = "https://polygon.example/"

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[object]]] = []

    def wire_method(self, name: str) -> str:
        return {
            "eth_chain_id": "eth_chainId",
            "eth_get_balance": "eth_getBalance",
            "eth_call": "eth_call",
        }[name]

    async def request(self, method: str, params: list[object], _options: object) -> str:
        self.calls.append((method, params))
        return "0x89"


@pytest.mark.asyncio
async def test_polygon_sealed_reads_use_generated_methods_and_positional_params() -> None:
    transport = _Transport()
    rpc = create_polygon_client(transport).rpc
    assert POLYGON_RPC_METHODS == ("eth_call", "eth_chainId", "eth_getBalance")
    assert {name for name in dir(rpc) if not name.startswith("_")} == {
        "endpoint",
        "eth_call",
        "eth_chain_id",
        "eth_get_balance",
    }
    await rpc.eth_chain_id().send()
    await rpc.eth_get_balance("0xabc", "latest").send()
    await rpc.eth_call({"to": "0xabc"}).send()
    assert transport.calls == [
        ("eth_chainId", []),
        ("eth_getBalance", ["0xabc", "latest"]),
        ("eth_call", [{"to": "0xabc"}]),
    ]
