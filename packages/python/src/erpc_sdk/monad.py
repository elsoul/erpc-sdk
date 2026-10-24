"""Explicit sealed Monad mainnet JSON-RPC read facade."""

from __future__ import annotations

from dataclasses import dataclass

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from .base import SealedEvmRpcClient, _SealedEvmHttpTransport, sealed_evm_transport_facts

_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-monad-rpc")
MONAD_RPC_METHODS = _TRANSPORT_FACTS.method_names


class MonadRpcClient(SealedEvmRpcClient):
    """Monad mainnet's sealed eth_chain_id, eth_get_balance, and eth_call reads."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class MonadClient:
    rpc: MonadRpcClient


def create_monad_client(transport: _SealedEvmHttpTransport) -> MonadClient:
    return MonadClient(rpc=MonadRpcClient(transport))


__all__ = ["MONAD_RPC_METHODS", "MonadClient", "MonadRpcClient", "create_monad_client"]
