"""Top-level ERPC and Cloud client composition."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from ._rpc_network_contract_data import RPC_NETWORK_CONTRACT as _RPC_NETWORK_CONTRACT
from ._sui_grpc_web import SuiGrpcWebTransport
from .arbitrum import ArbitrumClient, create_arbitrum_client
from .arc import ArcClient, create_arc_client
from .base import (
    BaseClient,
    SealedEvmTransportFacts,
    _SealedEvmHttpTransport,
    create_base_client,
    sealed_evm_transport_facts,
)
from .bitcoin import BitcoinClient, create_bitcoin_client
from .bitcoin_transport import BitcoinHttpTransport, bitcoin_transport_facts
from .bsc import BscClient, create_bsc_client
from .config import (
    ErpcClientConfig,
    ErpcCloudClientConfig,
    RpcEndpointConfig,
    direct_endpoint_redactions,
    endpoint_with_path,
    websocket_url,
)
from .hyperliquid import HyperliquidClient, create_hyperliquid_client
from .kaia import KaiaClient, create_kaia_client
from .monad import MonadClient, create_monad_client
from .near import NearClient, create_near_client
from .near_transport import NearHttpTransport
from .optimism import OptimismClient, create_optimism_client
from .polygon import PolygonClient, create_polygon_client
from .rest import (
    AccountClient,
    CloudCatalogClient,
    CloudCreditClient,
    CloudResourcesClient,
    PriceClient,
    UsageClient,
)
from .robinhood import RobinhoodClient, create_robinhood_client
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
from .soneium import SoneiumClient, create_soneium_client
from .subscriptions import (
    EthereumSubscriptions,
    SolanaSubscriptions,
    UnavailableWebSocketJsonRpcTransport,
    WebSocketJsonRpcTransport,
)
from .sui import SuiClient, create_sui_client
from .swap import SwapClient
from .transport import (
    HttpJsonRpcTransport,
    RestTransport,
    UnavailableHttpJsonRpcTransport,
    UnavailableRestTransport,
)
from .tron import TronClient, create_tron_client


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


_BASE_TRANSPORT_FACTS = sealed_evm_transport_facts(
    _RPC_NETWORK_CONTRACT,
    "client-base-rpc",
)
_ARBITRUM_TRANSPORT_FACTS = sealed_evm_transport_facts(
    _RPC_NETWORK_CONTRACT,
    "client-arbitrum-rpc",
)
_BITCOIN_TRANSPORT_FACTS = bitcoin_transport_facts(_RPC_NETWORK_CONTRACT)
_POLYGON_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-polygon-rpc")
_BSC_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-bsc-rpc")
_OPTIMISM_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-optimism-rpc")
_KAIA_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-kaia-rpc")
_SONEIUM_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-soneium-rpc")
_MONAD_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-monad-rpc")
_HYPERLIQUID_TRANSPORT_FACTS = sealed_evm_transport_facts(
    _RPC_NETWORK_CONTRACT, "client-hyperliquid-rpc"
)
_ARC_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-arc-rpc")
_ROBINHOOD_TRANSPORT_FACTS = sealed_evm_transport_facts(
    _RPC_NETWORK_CONTRACT, "client-robinhood-rpc"
)
_TRON_TRANSPORT_FACTS = sealed_evm_transport_facts(_RPC_NETWORK_CONTRACT, "client-tron-rpc")


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


def _sealed_evm_transport(
    config: ErpcClientConfig,
    override: RpcEndpointConfig | None,
    hosted_endpoint: str,
    namespace: str,
    facts: SealedEvmTransportFacts,
    client: httpx.AsyncClient,
) -> _SealedEvmHttpTransport:
    if override is not None:
        return _SealedEvmHttpTransport(
            facts=facts,
            direct_endpoint=override,
            timeout=config.timeout,
            http_client=client,
            namespace=namespace,
        )
    if config.api_key is None:
        return _SealedEvmHttpTransport(
            facts=facts,
            timeout=config.timeout,
            http_client=client,
            namespace=namespace,
        )
    return _SealedEvmHttpTransport(
        facts=facts,
        api_key=config.api_key,
        endpoint=hosted_endpoint,
        headers=config.headers,
        timeout=config.timeout,
        http_client=client,
        namespace=namespace,
    )


def _bitcoin_transport(
    config: ErpcClientConfig,
    client: httpx.AsyncClient,
) -> BitcoinHttpTransport:
    if config.bitcoin_rpc is not None:
        return BitcoinHttpTransport(
            facts=_BITCOIN_TRANSPORT_FACTS,
            direct_endpoint=config.bitcoin_rpc,
            timeout=config.timeout,
            http_client=client,
        )
    if config.api_key is None:
        return BitcoinHttpTransport(
            facts=_BITCOIN_TRANSPORT_FACTS,
            timeout=config.timeout,
            http_client=client,
        )
    return BitcoinHttpTransport(
        facts=_BITCOIN_TRANSPORT_FACTS,
        api_key=config.api_key,
        endpoint=config.endpoint,
        headers=config.headers,
        timeout=config.timeout,
        http_client=client,
    )


def _near_transport(
    config: ErpcClientConfig,
    client: httpx.AsyncClient,
) -> NearHttpTransport:
    if config.near_rpc is not None:
        return NearHttpTransport(
            direct_endpoint=config.near_rpc,
            timeout=config.timeout,
            http_client=client,
        )
    if config.api_key is None:
        return NearHttpTransport(
            timeout=config.timeout,
            http_client=client,
            namespace="near.rpc",
        )
    return NearHttpTransport(
        api_key=config.api_key,
        endpoint=config.near_endpoint,
        headers=config.headers,
        timeout=config.timeout,
        http_client=client,
    )


def _sui_transport(
    config: ErpcClientConfig,
    client: httpx.AsyncClient,
) -> SuiGrpcWebTransport:
    if config.sui_grpc_web is not None:
        return SuiGrpcWebTransport(
            direct_endpoint=config.sui_grpc_web,
            timeout=config.timeout,
            http_client=client,
        )
    if config.api_key is None:
        return SuiGrpcWebTransport(
            timeout=config.timeout,
            http_client=client,
            namespace="sui.grpc",
        )
    return SuiGrpcWebTransport(
        api_key=config.api_key,
        endpoint=config.sui_endpoint,
        headers=config.headers,
        timeout=config.timeout,
        http_client=client,
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

    bitcoin: BitcoinClient
    base: BaseClient
    arbitrum: ArbitrumClient
    polygon: PolygonClient
    bsc: BscClient
    optimism: OptimismClient
    kaia: KaiaClient
    soneium: SoneiumClient
    monad: MonadClient
    hyperliquid: HyperliquidClient
    arc: ArcClient
    robinhood: RobinhoodClient
    near: NearClient
    tron: TronClient
    sui: SuiClient

    def __init__(
        self,
        config: ErpcClientConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        client = http_client or httpx.AsyncClient(timeout=None, follow_redirects=False)
        self._http_client = client
        self._owns_http_client = http_client is None
        base_transport = _sealed_evm_transport(
            config,
            config.base_rpc,
            config.base_endpoint,
            "base.rpc",
            _BASE_TRANSPORT_FACTS,
            client,
        )
        arbitrum_transport = _sealed_evm_transport(
            config,
            config.arbitrum_rpc,
            config.arbitrum_endpoint,
            "arbitrum.rpc",
            _ARBITRUM_TRANSPORT_FACTS,
            client,
        )
        bitcoin_transport = _bitcoin_transport(config, client)
        polygon_transport = _sealed_evm_transport(
            config,
            config.polygon_rpc,
            config.polygon_endpoint,
            "polygon.rpc",
            _POLYGON_TRANSPORT_FACTS,
            client,
        )
        bsc_transport = _sealed_evm_transport(
            config,
            config.bsc_rpc,
            config.bsc_endpoint,
            "bsc.rpc",
            _BSC_TRANSPORT_FACTS,
            client,
        )
        optimism_transport = _sealed_evm_transport(
            config,
            config.optimism_rpc,
            config.optimism_endpoint,
            "optimism.rpc",
            _OPTIMISM_TRANSPORT_FACTS,
            client,
        )
        kaia_transport = _sealed_evm_transport(
            config,
            config.kaia_rpc,
            config.kaia_endpoint,
            "kaia.rpc",
            _KAIA_TRANSPORT_FACTS,
            client,
        )
        soneium_transport = _sealed_evm_transport(
            config,
            config.soneium_rpc,
            config.soneium_endpoint,
            "soneium.rpc",
            _SONEIUM_TRANSPORT_FACTS,
            client,
        )
        monad_transport = _sealed_evm_transport(
            config,
            config.monad_rpc,
            config.monad_endpoint,
            "monad.rpc",
            _MONAD_TRANSPORT_FACTS,
            client,
        )
        hyperliquid_transport = _sealed_evm_transport(
            config,
            config.hyperliquid_rpc,
            config.hyperliquid_endpoint,
            "hyperliquid.rpc",
            _HYPERLIQUID_TRANSPORT_FACTS,
            client,
        )
        arc_transport = _sealed_evm_transport(
            config,
            config.arc_rpc,
            config.arc_endpoint,
            "arc.rpc",
            _ARC_TRANSPORT_FACTS,
            client,
        )
        robinhood_transport = _sealed_evm_transport(
            config,
            config.robinhood_rpc,
            config.robinhood_endpoint,
            "robinhood.rpc",
            _ROBINHOOD_TRANSPORT_FACTS,
            client,
        )
        tron_transport = _sealed_evm_transport(
            config,
            config.tron_rpc,
            config.tron_endpoint,
            "tron.rpc",
            _TRON_TRANSPORT_FACTS,
            client,
        )
        near_transport = _near_transport(config, client)
        sui_transport = _sui_transport(config, client)
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
        self.base = create_base_client(base_transport)
        self.arbitrum = create_arbitrum_client(arbitrum_transport)
        self.bitcoin = create_bitcoin_client(bitcoin_transport)
        self.polygon = create_polygon_client(polygon_transport)
        self.bsc = create_bsc_client(bsc_transport)
        self.optimism = create_optimism_client(optimism_transport)
        self.kaia = create_kaia_client(kaia_transport)
        self.soneium = create_soneium_client(soneium_transport)
        self.monad = create_monad_client(monad_transport)
        self.hyperliquid = create_hyperliquid_client(hyperliquid_transport)
        self.arc = create_arc_client(arc_transport)
        self.robinhood = create_robinhood_client(robinhood_transport)
        self.near = create_near_client(near_transport)
        self.tron = create_tron_client(tron_transport)
        self.sui = create_sui_client(sui_transport)
        self.swap = SwapClient(ethereum_transport, avalanche_transport)
        self._base_transport = base_transport
        self._arbitrum_transport = arbitrum_transport
        self._bitcoin_transport = bitcoin_transport
        self._sealed_chain_transports = (
            polygon_transport,
            bsc_transport,
            optimism_transport,
            kaia_transport,
            soneium_transport,
            monad_transport,
            hyperliquid_transport,
            arc_transport,
            robinhood_transport,
            tron_transport,
        )
        self._near_transport = near_transport
        self._sui_transport = sui_transport
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
        await self._base_transport.close()
        await self._arbitrum_transport.close()
        await self._bitcoin_transport.close()
        for transport in self._sealed_chain_transports:
            await transport.close()
        await self._near_transport.close()
        await self._sui_transport.close()
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
