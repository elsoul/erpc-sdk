"""Explicit sealed Arbitrum JSON-RPC read facade for bootstrap source tests."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import BaseRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_GENERATED_ARBITRUM_FACTS = sealed_evm_transport_facts(
    _RPC_NETWORK_CONTRACT,
    "client-arbitrum-rpc",
)
ARBITRUM_RPC_METHODS = _GENERATED_ARBITRUM_FACTS.method_names


class ArbitrumRpcClient(BaseRpcClient):
    """Arbitrum's sealed three-read method surface."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class ArbitrumClient:
    rpc: ArbitrumRpcClient


def create_arbitrum_client(transport: _SealedEvmHttpTransport) -> ArbitrumClient:
    return ArbitrumClient(rpc=ArbitrumRpcClient(transport))


__all__ = [
    "ARBITRUM_RPC_METHODS",
    "ArbitrumClient",
    "ArbitrumRpcClient",
    "create_arbitrum_client",
]
