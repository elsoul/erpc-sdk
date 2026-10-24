"""Explicit sealed Polygon JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-polygon-rpc")
POLYGON_RPC_METHODS = _TRANSPORT_FACTS.method_names


class PolygonRpcClient(SealedEvmRpcClient):
    """Polygon's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class PolygonClient:
    rpc: PolygonRpcClient


def create_polygon_client(transport: _SealedEvmHttpTransport) -> PolygonClient:
    return PolygonClient(rpc=PolygonRpcClient(transport))


__all__ = ["POLYGON_RPC_METHODS", "PolygonClient", "PolygonRpcClient", "create_polygon_client"]
