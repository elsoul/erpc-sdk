"""Explicit sealed Robinhood Chain public mainnet read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-robinhood-rpc")
ROBINHOOD_RPC_METHODS = _TRANSPORT_FACTS.method_names


class RobinhoodRpcClient(SealedEvmRpcClient):
    """Robinhood Chain's public sealed read surface."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class RobinhoodClient:
    rpc: RobinhoodRpcClient


def create_robinhood_client(transport: _SealedEvmHttpTransport) -> RobinhoodClient:
    return RobinhoodClient(rpc=RobinhoodRpcClient(transport))


__all__ = [
    "ROBINHOOD_RPC_METHODS",
    "RobinhoodClient",
    "RobinhoodRpcClient",
    "create_robinhood_client",
]
