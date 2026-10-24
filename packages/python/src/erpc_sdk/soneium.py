"""Explicit sealed Soneium JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-soneium-rpc")
SONEIUM_RPC_METHODS = _TRANSPORT_FACTS.method_names


class SoneiumRpcClient(SealedEvmRpcClient):
    """Soneium's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class SoneiumClient:
    rpc: SoneiumRpcClient


def create_soneium_client(transport: _SealedEvmHttpTransport) -> SoneiumClient:
    return SoneiumClient(rpc=SoneiumRpcClient(transport))


__all__ = [
    "SONEIUM_RPC_METHODS",
    "SoneiumClient",
    "SoneiumRpcClient",
    "create_soneium_client",
]
