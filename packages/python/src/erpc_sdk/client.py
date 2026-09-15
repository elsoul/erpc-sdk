"""Top-level ERPC and Cloud client composition."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from .config import (
    ErpcClientConfig,
    ErpcCloudClientConfig,
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
    WebSocketJsonRpcTransport,
)
from .swap import SwapClient
from .transport import HttpJsonRpcTransport, RestTransport


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
        solana_transport = HttpJsonRpcTransport(
            api_key=config.api_key,
            endpoint=config.endpoint,
            headers=config.headers,
            timeout=config.timeout,
            client=client,
        )
        ethereum_transport = HttpJsonRpcTransport(
            api_key=config.api_key,
            endpoint=endpoint_with_path(config.endpoint, "/eth"),
            headers=config.headers,
            timeout=config.timeout,
            client=client,
        )
        avalanche_transport = HttpJsonRpcTransport(
            api_key=config.api_key,
            endpoint=endpoint_with_path(config.avalanche_endpoint, "/ava"),
            headers=config.headers,
            timeout=config.timeout,
            client=client,
        )

        def avalanche_index_transport(path: str) -> HttpJsonRpcTransport:
            return HttpJsonRpcTransport(
                api_key=config.api_key,
                endpoint=endpoint_with_path(config.avalanche_endpoint, path),
                headers=config.headers,
                timeout=config.timeout,
                client=client,
            )
        solana_ws = WebSocketJsonRpcTransport(
            websocket_url(config.endpoint, config.api_key),
            config.api_key,
            config.timeout,
        )
        ethereum_ws = WebSocketJsonRpcTransport(
            websocket_url(config.endpoint, config.api_key, "/eth"),
            config.api_key,
            config.timeout,
        )
        avalanche_ws = WebSocketJsonRpcTransport(
            websocket_url(config.avalanche_endpoint, config.api_key, "/ava-ws"),
            config.api_key,
            config.timeout,
        )
        self.solana = SolanaClient(
            rpc=RpcNamespace(
                solana_transport,
                SOLANA_RPC_METHODS,
                parameter_mode="positional",
                batch_policy="solana-standard",
            ),
            das=RpcNamespace(solana_transport, SOLANA_DAS_METHODS, parameter_mode="named"),
            history=RpcNamespace(
                solana_transport, SOLANA_HISTORY_METHODS, parameter_mode="positional"
            ),
            leaders=RpcNamespace(
                solana_transport,
                SOLANA_LEADER_METHODS,
                parameter_mode="positional",
                batch_policy="unsupported",
            ),
            analytics=RpcNamespace(
                solana_transport,
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
                avalanche_transport,
                AVALANCHE_AVAX_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="avax",
            ),
            x_chain=RpcNamespace(
                avalanche_transport,
                AVALANCHE_X_CHAIN_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="avm",
            ),
            p_chain=RpcNamespace(
                avalanche_transport,
                AVALANCHE_P_CHAIN_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="platform",
            ),
            proposer_vm=RpcNamespace(
                avalanche_transport,
                AVALANCHE_PROPOSER_VM_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="proposervm",
            ),
            info=RpcNamespace(
                avalanche_transport,
                AVALANCHE_INFO_METHODS,
                parameter_mode="named",
                batch_policy="unsupported",
                method_prefix="info",
            ),
            index=AvalancheIndexClient(
                c_chain_blocks=RpcNamespace(
                    avalanche_index_transport("/ava/ext/index/C/block"),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                p_chain_blocks=RpcNamespace(
                    avalanche_index_transport("/ava/ext/index/P/block"),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                x_chain_blocks=RpcNamespace(
                    avalanche_index_transport("/ava/ext/index/X/block"),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
                x_chain_transactions=RpcNamespace(
                    avalanche_index_transport("/ava/ext/index/X/tx"),
                    AVALANCHE_INDEX_METHODS,
                    parameter_mode="named",
                    batch_policy="unsupported",
                    method_prefix="index",
                ),
            ),
            subscriptions=EthereumSubscriptions(avalanche_ws),
        )
        self.swap = SwapClient(ethereum_transport, avalanche_transport)
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
