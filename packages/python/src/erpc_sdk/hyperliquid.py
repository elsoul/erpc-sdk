"""Explicit sealed Hyperliquid HyperEVM JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-hyperliquid-rpc")
HYPERLIQUID_RPC_METHODS = _TRANSPORT_FACTS.method_names


class HyperliquidRpcClient(SealedEvmRpcClient):
    """HyperEVM's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class HyperliquidClient:
    rpc: HyperliquidRpcClient


def create_hyperliquid_client(transport: _SealedEvmHttpTransport) -> HyperliquidClient:
    return HyperliquidClient(rpc=HyperliquidRpcClient(transport))


__all__ = [
    "HYPERLIQUID_RPC_METHODS",
    "HyperliquidClient",
    "HyperliquidRpcClient",
    "create_hyperliquid_client",
]
