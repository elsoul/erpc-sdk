"""Explicit sealed BNB Smart Chain JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-bsc-rpc")
BSC_RPC_METHODS = _TRANSPORT_FACTS.method_names


class BscRpcClient(SealedEvmRpcClient):
    """BSC's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class BscClient:
    rpc: BscRpcClient


def create_bsc_client(transport: _SealedEvmHttpTransport) -> BscClient:
    return BscClient(rpc=BscRpcClient(transport))


__all__ = ["BSC_RPC_METHODS", "BscClient", "BscRpcClient", "create_bsc_client"]
