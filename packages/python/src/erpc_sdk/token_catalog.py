"""Offline token and deployment catalog lookups.

The records in :mod:`erpc_sdk._token_catalog_data` are generated from the
canonical registry.  This module only builds small in-memory indexes over
those records; catalog reads never require a client, API key, filesystem, or
network access.
"""

from __future__ import annotations

import re
from typing import Final, Literal, TypeAlias, TypeGuard

from ._token_catalog_data import (
    TOKEN_ALIASES,
    TOKEN_ASSETS,
    TOKEN_CATALOG_AS_OF_DATE,
    TOKEN_CATALOG_CONTENT_DIGEST,
    TOKEN_CATALOG_VERSION,
    TOKEN_CHAIN_IDS,
    TOKEN_DEPLOYMENTS,
    TOKENS,
    TokenAlias,
    TokenAsset,
    TokenChainId,
    TokenDeployment,
    TokenRepresentationKind,
    TokenStableCurrency,
    TokenStandard,
    TokenStatus,
    tokens,
)

StableCurrency: TypeAlias = Literal["USD", "EUR", "JPY"]


class TokenChainIds:
    """Canonical chain IDs used by the bundled token catalog."""

    ETHEREUM_MAINNET: Final[TokenChainId] = "eip155:1"
    SOLANA_MAINNET: Final[TokenChainId] = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    AVALANCHE_C_MAINNET: Final[TokenChainId] = "eip155:43114"

    def __init__(self) -> None:
        raise TypeError("TokenChainIds is a constants namespace")


_EVM_CHAIN_IDS: Final[frozenset[str]] = frozenset(
    {
        TokenChainIds.ETHEREUM_MAINNET,
        TokenChainIds.AVALANCHE_C_MAINNET,
    }
)
_KNOWN_CHAIN_IDS: Final[frozenset[str]] = frozenset(
    {
        TokenChainIds.ETHEREUM_MAINNET,
        TokenChainIds.SOLANA_MAINNET,
        TokenChainIds.AVALANCHE_C_MAINNET,
    }
)
_STABLE_CURRENCIES: Final[frozenset[str]] = frozenset({"USD", "EUR", "JPY"})
_EMPTY_DEPLOYMENTS: Final[tuple[TokenDeployment, ...]] = ()
_EVM_ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")

_ASSETS_BY_ID: Final[dict[str, TokenAsset]] = {
    asset.asset_id: asset for asset in TOKEN_ASSETS
}
_DEPLOYMENTS_BY_ID: Final[dict[str, TokenDeployment]] = {
    deployment.deployment_id: deployment for deployment in TOKEN_DEPLOYMENTS
}

_DEPLOYMENTS_BY_SYMBOL: dict[tuple[str, str], list[TokenDeployment]] = {}
for _deployment in TOKEN_DEPLOYMENTS:
    _DEPLOYMENTS_BY_SYMBOL.setdefault(
        (_deployment.chain_id, _deployment.symbol), []
    ).append(_deployment)
_DEPLOYMENTS_BY_SYMBOL_FROZEN: Final[dict[tuple[str, str], tuple[TokenDeployment, ...]]] = {
    key: tuple(sorted(values, key=lambda deployment: deployment.deployment_id))
    for key, values in _DEPLOYMENTS_BY_SYMBOL.items()
}

_DEPLOYMENTS_BY_ADDRESS: Final[dict[tuple[str, str], TokenDeployment]] = {}
for _deployment in TOKEN_DEPLOYMENTS:
    if _deployment.address is None or _deployment.address == "":
        continue
    _address = _deployment.address
    if _deployment.chain_id in _EVM_CHAIN_IDS:
        # Generated records are validated before emission.  Keep this guard
        # so lookup indexes remain safe if a hand-edited generated file is
        # accidentally imported during development.
        if _EVM_ADDRESS.fullmatch(_address) is None:
            continue
        _address = _address.lower()
        if _address == "0x" + "0" * 40:
            continue
    _DEPLOYMENTS_BY_ADDRESS.setdefault((_deployment.chain_id, _address), _deployment)


def get_token_asset(asset_id: object) -> TokenAsset | None:
    """Return the exact catalog asset identified by opaque ``asset_id``."""

    if not isinstance(asset_id, str):
        return None
    return _ASSETS_BY_ID.get(asset_id)


def get_token_deployment(deployment_id: object) -> TokenDeployment | None:
    """Return the exact catalog deployment identified by opaque ID."""

    if not isinstance(deployment_id, str):
        return None
    return _DEPLOYMENTS_BY_ID.get(deployment_id)


def list_token_deployments(
    chain_id: object = None,
    stable_currency: object = None,
) -> tuple[TokenDeployment, ...]:
    """List deployments, optionally filtered by chain and stable currency.

    Every lifecycle status remains visible. Invalid filter values produce an
    empty tuple so callers can safely pass untrusted input to this offline
    lookup API.
    """

    if chain_id is not None and not _is_known_chain_id(chain_id):
        return _EMPTY_DEPLOYMENTS
    if stable_currency is not None and not _is_stable_currency(stable_currency):
        return _EMPTY_DEPLOYMENTS

    filtered = tuple(
        deployment
        for deployment in TOKEN_DEPLOYMENTS
        if (chain_id is None or deployment.chain_id == chain_id)
        and (stable_currency is None or deployment.stable_currency == stable_currency)
    )
    return filtered if filtered else _EMPTY_DEPLOYMENTS


def find_token_deployments_by_symbol(
    chain_id: object,
    symbol: object,
) -> tuple[TokenDeployment, ...]:
    """Find exact-case symbol matches on a chain sorted by deployment ID."""

    if not _is_known_chain_id(chain_id) or not isinstance(symbol, str) or not symbol:
        return _EMPTY_DEPLOYMENTS
    return _DEPLOYMENTS_BY_SYMBOL_FROZEN.get((chain_id, symbol), _EMPTY_DEPLOYMENTS)


def find_token_deployment_by_address(
    chain_id: object,
    address: object,
) -> TokenDeployment | None:
    """Find a deployment by chain-qualified address.

    EVM addresses must be ``0x`` followed by 40 ASCII hexadecimal characters
    and are matched case-insensitively. Solana addresses are matched exactly.
    Native deployments have no address and are never selected here.
    """

    if not _is_known_chain_id(chain_id) or not isinstance(address, str) or not address:
        return None
    normalized = address
    if chain_id in _EVM_CHAIN_IDS:
        if _EVM_ADDRESS.fullmatch(address) is None:
            return None
        normalized = address.lower()
        if normalized == "0x" + "0" * 40:
            return None
    return _DEPLOYMENTS_BY_ADDRESS.get((chain_id, normalized))


def get_native_token_deployment(chain_id: object) -> TokenDeployment | None:
    """Return the known chain's native deployment, whose address is ``None``."""

    if not _is_known_chain_id(chain_id):
        return None
    for deployment in TOKEN_DEPLOYMENTS:
        if (
            deployment.chain_id == chain_id
            and deployment.standard == "native"
            and deployment.address is None
        ):
            return deployment
    return None


def _is_known_chain_id(value: object) -> TypeGuard[TokenChainId]:
    return isinstance(value, str) and value in _KNOWN_CHAIN_IDS


def _is_stable_currency(value: object) -> TypeGuard[StableCurrency]:
    return isinstance(value, str) and value in _STABLE_CURRENCIES


__all__ = [
    "StableCurrency",
    "TOKENS",
    "TOKEN_ALIASES",
    "TOKEN_ASSETS",
    "TOKEN_CATALOG_AS_OF_DATE",
    "TOKEN_CATALOG_CONTENT_DIGEST",
    "TOKEN_CATALOG_VERSION",
    "TOKEN_CHAIN_IDS",
    "TOKEN_DEPLOYMENTS",
    "TokenAlias",
    "TokenAsset",
    "TokenChainId",
    "TokenChainIds",
    "TokenDeployment",
    "TokenRepresentationKind",
    "TokenStableCurrency",
    "TokenStandard",
    "TokenStatus",
    "find_token_deployment_by_address",
    "find_token_deployments_by_symbol",
    "get_native_token_deployment",
    "get_token_asset",
    "get_token_deployment",
    "list_token_deployments",
    "tokens",
]
