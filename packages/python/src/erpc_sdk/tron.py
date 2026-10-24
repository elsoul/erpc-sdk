"""Explicit sealed TRON EVM-compatible JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-tron-rpc")
TRON_RPC_METHODS = _TRANSPORT_FACTS.method_names


class TronRpcClient(SealedEvmRpcClient):
    """TRON reads preserve the provider root and caller supplied addresses."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class TronClient:
    rpc: TronRpcClient


def create_tron_client(transport: _SealedEvmHttpTransport) -> TronClient:
    return TronClient(rpc=TronRpcClient(transport))


__all__ = ["TRON_RPC_METHODS", "TronClient", "TronRpcClient", "create_tron_client"]
