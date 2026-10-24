"""Explicit sealed OP Mainnet JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-optimism-rpc")
OPTIMISM_RPC_METHODS = _TRANSPORT_FACTS.method_names


class OptimismRpcClient(SealedEvmRpcClient):
    """Optimism's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class OptimismClient:
    rpc: OptimismRpcClient


def create_optimism_client(transport: _SealedEvmHttpTransport) -> OptimismClient:
    return OptimismClient(rpc=OptimismRpcClient(transport))


__all__ = [
    "OPTIMISM_RPC_METHODS",
    "OptimismClient",
    "OptimismRpcClient",
    "create_optimism_client",
]
