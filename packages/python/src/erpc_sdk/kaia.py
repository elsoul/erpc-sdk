"""Explicit sealed Kaia JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-kaia-rpc")
KAIA_RPC_METHODS = _TRANSPORT_FACTS.method_names


class KaiaRpcClient(SealedEvmRpcClient):
    """Kaia's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class KaiaClient:
    rpc: KaiaRpcClient


def create_kaia_client(transport: _SealedEvmHttpTransport) -> KaiaClient:
    return KaiaClient(rpc=KaiaRpcClient(transport))


__all__ = ["KAIA_RPC_METHODS", "KaiaClient", "KaiaRpcClient", "create_kaia_client"]
