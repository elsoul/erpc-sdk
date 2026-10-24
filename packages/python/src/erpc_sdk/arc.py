"""Explicit sealed Arc mainnet JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-arc-rpc")
ARC_RPC_METHODS = _TRANSPORT_FACTS.method_names


class ArcRpcClient(SealedEvmRpcClient):
    """Arc's sealed reads preserve raw hexadecimal wire units."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class ArcClient:
    rpc: ArcRpcClient


def create_arc_client(transport: _SealedEvmHttpTransport) -> ArcClient:
    return ArcClient(rpc=ArcRpcClient(transport))


__all__ = ["ARC_RPC_METHODS", "ArcClient", "ArcRpcClient", "create_arc_client"]
