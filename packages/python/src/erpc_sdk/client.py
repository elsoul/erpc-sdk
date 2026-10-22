"""Top-level ERPC and Cloud client composition."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from .config import (
    ErpcClientConfig,
    ErpcCloudClientConfig,
    RpcEndpointConfig,
    direct_endpoint_redactions,
    endpoint_with_path,
    websocket_url,
)
from .rest import (
    AccountClient,
    CloudCatalogClient,
    CloudCreditClient,
    CloudResourcesClient,
    PriceClient,
    UsageClient,
)
from .rpc import (
    AVALANCHE_AVAX_METHODS,
    AVALANCHE_INDEX_METHODS,
    AVALANCHE_INFO_METHODS,
    AVALANCHE_P_CHAIN_METHODS,
    AVALANCHE_PROPOSER_VM_METHODS,
    AVALANCHE_X_CHAIN_METHODS,
    ETHEREUM_RPC_METHODS,
    SOLANA_ANALYTICS_METHODS,
    SOLANA_DAS_METHODS,
    SOLANA_HISTORY_METHODS,
    SOLANA_LEADER_METHODS,
    SOLANA_RPC_METHODS,
    RpcNamespace,
)
from .subscriptions import (
    EthereumSubscriptions,
    SolanaSubscriptions,
    UnavailableWebSocketJsonRpcTransport,
    WebSocketJsonRpcTransport,
)
from .swap import SwapClient
from .transport import (
    HttpJsonRpcTransport,
    RestTransport,
    UnavailableHttpJsonRpcTransport,
    UnavailableRestTransport,
)


@dataclass(frozen=True, slots=True)
class SolanaClient:
    rpc: RpcNamespace
    das: RpcNamespace
    history: RpcNamespace
    leaders: RpcNamespace
    analytics: RpcNamespace
    subscriptions: SolanaSubscriptions


@dataclass(frozen=True, slots=True)
class EthereumClient:
    rpc: RpcNamespace
    subscriptions: EthereumSubscriptions


@dataclass(frozen=True, slots=True)
class AvalancheIndexClient:
    c_chain_blocks: RpcNamespace
    p_chain_blocks: RpcNamespace
    x_chain_blocks: RpcNamespace
    x_chain_transactions: RpcNamespace


@dataclass(frozen=True, slots=True)
class AvalancheClient:
    """Avalanche C-Chain, native-chain, and Index API client."""

    rpc: RpcNamespace
    avax: RpcNamespace
    x_chain: RpcNamespace
    p_chain: RpcNamespace
    proposer_vm: RpcNamespace
    info: RpcNamespace
    index: AvalancheIndexClient
    subscriptions: EthereumSubscriptions


def _rpc_transport(
    config: ErpcClientConfig,
    override: RpcEndpointConfig | None,
    legacy_endpoint: str,
    namespace: str,
    client: httpx.AsyncClient,
) -> HttpJsonRpcTransport:
    if override is not None:
        return HttpJsonRpcTransport(
            api_key=None,
            endpoint=override.http_url,
            headers=override.headers,
            timeout=config.timeout,
            client=client,
            direct=True,
            redactions=direct_endpoint_redactions(override),
        )
    if config.api_key is None:
        return UnavailableHttpJsonRpcTransport(namespace)
    return HttpJsonRpcTransport(
        api_key=config.api_key,
        endpoint=legacy_endpoint,
        headers=config.headers,
        timeout=config.timeout,
        client=client,
    )


def _legacy_rpc_transport(
    config: ErpcClientConfig,
    endpoint: str,
    namespace: str,
    client: httpx.AsyncClient,
) -> HttpJsonRpcTransport:
    if config.api_key is None:
        return UnavailableHttpJsonRpcTransport(namespace)
    return HttpJsonRpcTransport(
        api_key=config.api_key,
        endpoint=endpoint,
        headers=config.headers,
        timeout=config.timeout,
        client=client,
    )


def _shared_or_unavailable(
    selected: HttpJsonRpcTransport,
    config: ErpcClientConfig,
    override: RpcEndpointConfig | None,
    namespace: str,
) -> HttpJsonRpcTransport:
    """Preserve shared legacy/direct IDs while naming keyless failures locally."""
    if config.api_key is None and override is None:
        return UnavailableHttpJsonRpcTransport(namespace)
    return selected


def _websocket_transport(
    config: ErpcClientConfig,
    override: RpcEndpointConfig | None,
    legacy_url: str,
    namespace: str,
) -> WebSocketJsonRpcTransport:
    if override is not None:
        if override.websocket_url is None:
            return UnavailableWebSocketJsonRpcTransport(namespace)
        return WebSocketJsonRpcTransport(
            override.websocket_url,
            "",
            config.timeout,
            direct=True,
            redactions=direct_endpoint_redactions(override),
        )
    if config.api_key is None:
        return UnavailableWebSocketJsonRpcTransport(namespace)
    return WebSocketJsonRpcTransport(legacy_url, config.api_key, config.timeout)


class ErpcClient:
    """Async-first client for JSON-RPC, REST, streams, and subscriptions."""

    def __init__(
        self,
        config: ErpcClientConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        client = http_client or httpx.AsyncClient(timeout=None, follow_redirects=False)
        self._http_client = client
        self._owns_http_client = http_client is None
        solana_transport = _rpc_transport(
            config,
            config.solana_rpc,
            config.endpoint,
            "solana.rpc",
            client,
        )
        solana_das_transport = _shared_or_unavailable(
            solana_transport, config, config.solana_rpc, "solana.das"
        )
        solana_history_transport = _shared_or_unavailable(
            solana_transport, config, config.solana_rpc, "solana.history"
        )
        solana_leaders_transport = _shared_or_unavailable(
            solana_transport, config, config.solana_rpc, "solana.leaders"
        )
        solana_analytics_transport = _shared_or_unavailable(
            solana_transport, config, config.solana_rpc, "solana.analytics"
        )
        ethereum_transport = _rpc_transport(
            config,
            config.ethereum_rpc,
            endpoint_with_path(config.endpoint, "/eth"),
            "ethereum.rpc",
            client,
        )
        avalanche_transport = _rpc_transport(
            config,
            config.avalanche_c_rpc,
            endpoint_with_path(config.avalanche_endpoint, "/ava"),
            "avalanche.rpc",
            client,
        )
        avalanche_legacy_transport = _legacy_rpc_transport(
            config,
            endpoint_with_path(config.avalanche_endpoint, "/ava"),
            "avalanche.avax",
            client,
        )
        avalanche_x_chain_transport = _shared_or_unavailable(
            avalanche_legacy_transport, config, None, "avalanche.x_chain"
        )
        avalanche_p_chain_transport = _shared_or_unavailable(
            avalanche_legacy_transport, config, None, "avalanche.p_chain"
        )
        avalanche_proposer_vm_transport = _shared_or_unavailable(
            avalanche_legacy_transport, config, None, "avalanche.proposer_vm"
        )
        avalanche_info_transport = _shared_or_unavailable(
            avalanche_legacy_transport, config, None, "avalanche.info"
        )

        def avalanche_index_transport(path: str, namespace: str) -> HttpJsonRpcTransport:
            return _legacy_rpc_transport(
                config,
                endpoint_with_path(config.avalanche_endpoint, path),
                namespace,
                client,
            )

        solana_ws = _websocket_transport(
            config,
            config.solana_rpc,
            websocket_url(config.endpoint, config.api_key or "")
            if config.api_key is not None
            else "",
            "solana.subscriptions",
        )
        ethereum_ws = _websocket_transport(
            config,
            config.ethereum_rpc,
            websocket_url(config.endpoint, config.api_key or "", "/eth")
            if config.api_key is not None
            else "",
            "ethereum.subscriptions",
        )
        avalanche_ws = _websocket_transport(
            config,
            config.avalanche_c_rpc,
            websocket_url(config.avalanche_endpoint, config.api_key or "", "/ava-ws")
            if config.api_key is not None
            else "",
            "avalanche.subscriptions",
        )
        self.solana = SolanaClient(
            rpc=RpcNamespace(
                solana_transport,
                SOLANA_RPC_METHODS,
                parameter_mode="positional",
                batch_policy="solana-standard",
            ),
            das=RpcNamespace(solana_das_transport, SOLANA_DAS_METHODS, parameter_mode="named"),
            history=RpcNamespace(
                solana_history_transport, SOLANA_HISTORY_METHODS, parameter_mode="positional"
            ),
            leaders=RpcNamespace(
                solana_leaders_transport,
                SOLANA_LEADER_METHODS,
                parameter_mode="positional",
                batch_policy="unsupported",
            ),
            analytics=RpcNamespace(
                solana_analytics_transport,
                SOLANA_ANALYTICS_METHODS,
                parameter_mode="positional",
            ),
            subscriptions=SolanaSubscriptions(solana_ws),
        )
        self.ethereum = EthereumClient(
            rpc=RpcNamespace(ethereum_transport, ETHEREUM_RPC_METHODS, parameter_mode="positional"),
            subscriptions=EthereumSubscriptions(ethereum_ws),
        )
        self.avalanche = AvalancheClient(
            rpc=RpcNamespace(
                avalanche_transport,
                ETHEREUM_RPC_METHODS,
                parameter_mode="positional",
            ),
            avax=RpcNamespace(
                avalanche_legacy_transport,
                AVALANCHE_AVAX_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="avax",
            ),
            x_chain=RpcNamespace(
                avalanche_x_chain_transport,
                AVALANCHE_X_CHAIN_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="avm",
            ),
            p_chain=RpcNamespace(
                avalanche_p_chain_transport,
                AVALANCHE_P_CHAIN_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="platform",
            ),
            proposer_vm=RpcNamespace(
                avalanche_proposer_vm_transport,
                AVALANCHE_PROPOSER_VM_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="proposervm",
            ),
            info=RpcNamespace(
                avalanche_info_transport,
                AVALANCHE_INFO_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="info",
            ),
            index=AvalancheIndexClient(
                c_chain_blocks=RpcNamespace(
                    avalanche_index_transport(
                        "/ava/ext/index/C/block", "avalanche.index.c_chain_blocks"
                    ),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                p_chain_blocks=RpcNamespace(
                    avalanche_index_transport(
                        "/ava/ext/index/P/block", "avalanche.index.p_chain_blocks"
                    ),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                x_chain_blocks=RpcNamespace(
                    avalanche_index_transport(
                        "/ava/ext/index/X/block", "avalanche.index.x_chain_blocks"
                    ),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                x_chain_transactions=RpcNamespace(
                    avalanche_index_transport(
                        "/ava/ext/index/X/tx", "avalanche.index.x_chain_transactions"
                    ),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
            ),
            subscriptions=EthereumSubscriptions(avalanche_ws),
        )
        self.swap = SwapClient(ethereum_transport, avalanche_transport)
        if config.api_key is None:
            self.price = PriceClient(UnavailableRestTransport("price"))
            self.account = AccountClient(UnavailableRestTransport("account"))
            self.usage = UsageClient(UnavailableRestTransport("usage"))
        else:
            self.price = PriceClient(
                RestTransport(
                    credential=config.api_key,
                    endpoint=config.endpoint,
                    headers=config.headers,
                    timeout=config.timeout,
                    client=client,
                )
            )
            self.account = AccountClient(
                RestTransport(
                    credential=config.api_key,
                    endpoint=config.account_endpoint,
                    headers=config.headers,
                    timeout=config.timeout,
                    client=client,
                )
            )
            self.usage = UsageClient(
                RestTransport(
                    credential=config.api_key,
                    endpoint=config.user_endpoint,
                    headers=config.headers,
                    timeout=config.timeout,
                    client=client,
                )
            )
        self._closed = False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.solana.subscriptions.close()
        await self.ethereum.subscriptions.close()
        await self.avalanche.subscriptions.close()
        if self._owns_http_client:
            await self._http_client.aclose()

    async def __aenter__(self) -> ErpcClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


class ErpcCloudClient:
    """Scoped Cloud catalog, credit, resource, and usage reads."""

    def __init__(
        self,
        config: ErpcCloudClientConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        client = http_client or httpx.AsyncClient(timeout=None, follow_redirects=False)
        self._http_client = client
        self._owns_http_client = http_client is None
        transport = RestTransport(
            credential=config.access_token,
            endpoint=config.endpoint,
            headers=config.headers,
            timeout=config.timeout,
            client=client,
        )
        self.catalog = CloudCatalogClient(transport)
        self.credit = CloudCreditClient(transport)
        self.resources = CloudResourcesClient(transport)
        self.usage = UsageClient(transport)
        self._closed = False

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._owns_http_client:
            await self._http_client.aclose()

    async def __aenter__(self) -> ErpcCloudClient:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()


def create_erpc_client(
    config: ErpcClientConfig, *, http_client: httpx.AsyncClient | None = None
) -> ErpcClient:
    return ErpcClient(config, http_client=http_client)


def create_erpc_cloud_client(
    config: ErpcCloudClientConfig, *, http_client: httpx.AsyncClient | None = None
) -> ErpcCloudClient:
    return ErpcCloudClient(config, http_client=http_client)
