import { AccountClient } from './account'
import {
  endpointWithPath,
  resolveConfig,
  websocketUrl,
  type ErpcClientConfig,
  type ResolvedArbitrumRpcEndpointConfig,
  type ResolvedBitcoinRpcEndpointConfig,
  type ResolvedRpcEndpointConfig,
  type ResolvedSuiGrpcWebEndpointConfig,
} from './config'
import { PriceClient } from './price'
import {
  createAvalancheClient,
  type AvalancheClient,
} from './rpc/avalanche'
import { createBaseClient, type ErpcBaseClient } from './rpc/base'
import { createArbitrumClient, type ErpcArbitrumClient } from './rpc/arbitrum'
import { createBitcoinClient, type ErpcBitcoinClient } from './rpc/bitcoin'
import { createBscClient, type ErpcBscClient } from './rpc/bsc'
import { createArcClient, type ErpcArcClient } from './rpc/arc'
import {
  createHyperliquidClient,
  type ErpcHyperliquidClient,
} from './rpc/hyperliquid'
import { createKaiaClient, type ErpcKaiaClient } from './rpc/kaia'
import { createMonadClient, type ErpcMonadClient } from './rpc/monad'
import {
  createEthereumClient,
  type EthereumClient,
} from './rpc/ethereum'
import { createSolanaClient, type SolanaClient } from './rpc/solana'
import {
  createOptimismClient,
  type ErpcOptimismClient,
} from './rpc/optimism'
import {
  createPolygonClient,
  type ErpcPolygonClient,
} from './rpc/polygon'
import {
  createSoneiumClient,
  type ErpcSoneiumClient,
} from './rpc/soneium'
import {
  createRobinhoodClient,
  type ErpcRobinhoodClient,
} from './rpc/robinhood'
import { createNearClient, type ErpcNearClient } from './rpc/near'
import { createSuiClient, type ErpcSuiClient } from './rpc/sui'
import { createTronClient, type ErpcTronClient } from './rpc/tron'
import {
  EthereumSubscriptions,
  SolanaSubscriptions,
} from './subscriptions'
import { createSwapClient, type SwapClient } from './swap'
import { HttpJsonRpcTransport } from './transport/http'
import { BitcoinHttpTransport } from './transport/bitcoin_http'
import { NearHttpTransport } from './transport/near_http'
import { SuiGrpcWebTransport } from './transport/sui-grpc-web'
import { RestTransport } from './transport/rest'
import { WebSocketJsonRpcTransport } from './transport/websocket'
import { UsageClient } from './usage'

export interface ErpcSolanaClient extends SolanaClient {
  readonly subscriptions: SolanaSubscriptions
}

export interface ErpcEthereumClient extends EthereumClient {
  readonly subscriptions: EthereumSubscriptions
}

export interface ErpcAvalancheClient extends AvalancheClient {
  readonly subscriptions: EthereumSubscriptions
}

export interface ErpcClient {
  readonly account: AccountClient
  readonly avalanche: ErpcAvalancheClient
  readonly arbitrum: ErpcArbitrumClient
  readonly base: ErpcBaseClient
  readonly bitcoin: ErpcBitcoinClient
  readonly bsc: ErpcBscClient
  readonly arc: ErpcArcClient
  readonly kaia: ErpcKaiaClient
  readonly ethereum: ErpcEthereumClient
  readonly optimism: ErpcOptimismClient
  readonly polygon: ErpcPolygonClient
  readonly monad: ErpcMonadClient
  readonly soneium: ErpcSoneiumClient
  readonly hyperliquid: ErpcHyperliquidClient
  readonly robinhood: ErpcRobinhoodClient
  readonly near: ErpcNearClient
  readonly sui: ErpcSuiClient
  readonly tron: ErpcTronClient
  readonly price: PriceClient
  readonly solana: ErpcSolanaClient
  readonly swap: SwapClient
  readonly usage: UsageClient
  close(): void
}

const unavailableEndpoint = (namespace: string): URL =>
  new URL(
    `https://unconfigured.invalid/${namespace.replace(/[^a-z\d._-]+/giu, '-')}`,
  )

export const createErpcClient = (config: ErpcClientConfig): ErpcClient => {
  const resolved = resolveConfig(config)
  const legacyTransport = {
    fetch: resolved.fetch,
    headers: resolved.headers,
    timeoutMs: resolved.timeoutMs,
    ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
  }

  const createUnavailableHttp = (namespace: string) =>
    new HttpJsonRpcTransport({
      endpoint: unavailableEndpoint(namespace),
      fetch: resolved.fetch,
      headers: {},
      timeoutMs: resolved.timeoutMs,
      unavailableNamespace: namespace,
      ...([
        'arbitrum.rpc',
        'arc.rpc',
        'bsc.rpc',
        'hyperliquid.rpc',
        'kaia.rpc',
        'monad.rpc',
        'optimism.rpc',
        'polygon.rpc',
        'robinhood.rpc',
        'soneium.rpc',
        'tron.rpc',
      ].includes(namespace) ? { diagnosticEndpoint: '' } : {}),
    })

  const createUnavailableBitcoin = () =>
    new BitcoinHttpTransport({
      endpoint: unavailableEndpoint('bitcoin.rpc'),
      fetch: resolved.fetch,
      headers: {},
      timeoutMs: resolved.timeoutMs,
      unavailableNamespace: 'bitcoin.rpc',
    })

  const createUnavailableWebSocket = (namespace: string) =>
    new WebSocketJsonRpcTransport({
      endpoint: unavailableEndpoint(namespace),
      timeoutMs: resolved.timeoutMs,
      unavailableNamespace: namespace,
    })

  const createDirectHttp = (
    endpoint: ResolvedRpcEndpointConfig,
  ) =>
    new HttpJsonRpcTransport({
      direct: true,
      endpoint: endpoint.httpUrl,
      fetch: resolved.fetch,
      headers: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
    })

  const createDirectSealedHttp = (
    endpoint: ResolvedRpcEndpointConfig | ResolvedArbitrumRpcEndpointConfig,
    strictResponse: boolean,
  ) =>
    new HttpJsonRpcTransport({
      direct: true,
      endpoint: endpoint.httpUrl,
      fetch: resolved.fetch,
      headers: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
      strictResponse,
    })

  const createDirectBitcoin = (endpoint: ResolvedBitcoinRpcEndpointConfig) =>
    new BitcoinHttpTransport({
      direct: true,
      endpoint: endpoint.httpUrl,
      fetch: resolved.fetch,
      headers: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
    })

  const createDirectNear = (endpoint: ResolvedRpcEndpointConfig) =>
    new NearHttpTransport({
      direct: true,
      endpoint: endpoint.httpUrl,
      fetch: resolved.fetch,
      headers: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
    })

  const createDirectSui = (endpoint: ResolvedSuiGrpcWebEndpointConfig) =>
    new SuiGrpcWebTransport({
      direct: true,
      endpoint: endpoint.baseUrl,
      fetch: resolved.fetch,
      headers: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
    })

  const createDirectWebSocket = (
    endpoint: ResolvedRpcEndpointConfig,
    namespace: string,
  ) => {
    if (endpoint.webSocketUrl === undefined) {
      return createUnavailableWebSocket(namespace)
    }
    return new WebSocketJsonRpcTransport({
      endpoint: endpoint.webSocketUrl,
      redactionHeaders: endpoint.headers,
      timeoutMs: resolved.timeoutMs,
      ...(resolved.webSocket === undefined
        ? {}
        : { webSocket: resolved.webSocket }),
    })
  }

  const createLegacyHttp = (
    endpoint: URL,
    redirect?: RequestRedirect,
    strictResponse = false,
  ) =>
    new HttpJsonRpcTransport({
      ...legacyTransport,
      endpoint,
      strictResponse,
      ...(redirect === undefined ? {} : { redirect }),
    })

  const createLegacyWebSocket = (endpoint: URL) =>
    new WebSocketJsonRpcTransport({
      endpoint,
      timeoutMs: resolved.timeoutMs,
      ...(resolved.webSocket === undefined
        ? {}
        : { webSocket: resolved.webSocket }),
    })

  const solanaTransport = resolved.solanaRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('solana.rpc')
      : createLegacyHttp(resolved.endpoint)
    : createDirectHttp(resolved.solanaRpc)

  const ethereumTransport = resolved.ethereumRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('ethereum.rpc')
      : createLegacyHttp(endpointWithPath(resolved.endpoint, '/eth'))
    : createDirectHttp(resolved.ethereumRpc)

  const avalancheTransport = resolved.avalancheCRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('avalanche.rpc')
      : createLegacyHttp(endpointWithPath(resolved.avalancheEndpoint, '/ava'))
    : createDirectHttp(resolved.avalancheCRpc)

  const baseTransport = resolved.baseRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('base')
      : createLegacyHttp(resolved.baseEndpoint, 'manual')
    : createDirectSealedHttp(resolved.baseRpc, false)

  const arbitrumTransport = resolved.arbitrumRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('arbitrum.rpc')
      : createLegacyHttp(resolved.arbitrumEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.arbitrumRpc, true)

  const bitcoinTransport = resolved.bitcoinRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableBitcoin()
      : new BitcoinHttpTransport({
          apiKey: resolved.apiKey,
          endpoint: resolved.endpoint,
          fetch: resolved.fetch,
          headers: resolved.headers,
          timeoutMs: resolved.timeoutMs,
        })
    : createDirectBitcoin(resolved.bitcoinRpc)

  const bscTransport = resolved.bscRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('bsc.rpc')
      : createLegacyHttp(resolved.bscEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.bscRpc, true)

  const arcTransport = resolved.arcRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('arc.rpc')
      : createLegacyHttp(resolved.arcEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.arcRpc, true)

  const hyperliquidTransport = resolved.hyperliquidRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('hyperliquid.rpc')
      : createLegacyHttp(resolved.hyperliquidEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.hyperliquidRpc, true)

  const kaiaTransport = resolved.kaiaRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('kaia.rpc')
      : createLegacyHttp(resolved.kaiaEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.kaiaRpc, true)

  const monadTransport = resolved.monadRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('monad.rpc')
      : createLegacyHttp(resolved.monadEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.monadRpc, true)

  const optimismTransport = resolved.optimismRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('optimism.rpc')
      : createLegacyHttp(resolved.optimismEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.optimismRpc, true)

  const polygonTransport = resolved.polygonRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('polygon.rpc')
      : createLegacyHttp(resolved.polygonEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.polygonRpc, true)

  const soneiumTransport = resolved.soneiumRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('soneium.rpc')
      : createLegacyHttp(resolved.soneiumEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.soneiumRpc, true)

  const robinhoodTransport = resolved.robinhoodRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('robinhood.rpc')
      : createLegacyHttp(resolved.robinhoodEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.robinhoodRpc, true)

  const nearTransport = resolved.nearRpc === undefined
    ? resolved.apiKey === undefined
      ? new NearHttpTransport({
          endpoint: unavailableEndpoint('near.rpc'),
          fetch: resolved.fetch,
          headers: {},
          timeoutMs: resolved.timeoutMs,
          unavailableNamespace: 'near.rpc',
        })
      : new NearHttpTransport({
          apiKey: resolved.apiKey,
          endpoint: resolved.nearEndpoint,
          fetch: resolved.fetch,
          headers: resolved.headers,
          timeoutMs: resolved.timeoutMs,
        })
    : createDirectNear(resolved.nearRpc)

  const tronTransport = resolved.tronRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableHttp('tron.rpc')
      : createLegacyHttp(resolved.tronEndpoint, 'manual', true)
    : createDirectSealedHttp(resolved.tronRpc, true)

  const suiTransport = resolved.suiGrpcWeb === undefined
    ? resolved.apiKey === undefined
      ? new SuiGrpcWebTransport({
          endpoint: unavailableEndpoint('sui.grpc'),
          fetch: resolved.fetch,
          headers: {},
          timeoutMs: resolved.timeoutMs,
          unavailableNamespace: 'sui.grpc',
        })
      : new SuiGrpcWebTransport({
          apiKey: resolved.apiKey,
          endpoint: resolved.suiEndpoint,
          fetch: resolved.fetch,
          headers: resolved.headers,
          timeoutMs: resolved.timeoutMs,
        })
    : createDirectSui(resolved.suiGrpcWeb)

  const avalancheNativeTransport = resolved.apiKey === undefined
    ? createUnavailableHttp('avalanche.native')
    : createLegacyHttp(endpointWithPath(resolved.avalancheEndpoint, '/ava'))

  const avalancheIndexTransport = (path: string, namespace: string) =>
    resolved.apiKey === undefined
      ? createUnavailableHttp(namespace)
      : createLegacyHttp(endpointWithPath(resolved.avalancheEndpoint, path))

  const solanaWebSocket = resolved.solanaRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableWebSocket('solana.subscriptions')
      : createLegacyWebSocket(websocketUrl(resolved.endpoint, resolved.apiKey))
    : createDirectWebSocket(resolved.solanaRpc, 'solana.subscriptions')

  const ethereumWebSocket = resolved.ethereumRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableWebSocket('ethereum.subscriptions')
      : createLegacyWebSocket(
        websocketUrl(resolved.endpoint, resolved.apiKey, '/eth'),
      )
    : createDirectWebSocket(resolved.ethereumRpc, 'ethereum.subscriptions')

  const avalancheWebSocket = resolved.avalancheCRpc === undefined
    ? resolved.apiKey === undefined
      ? createUnavailableWebSocket('avalanche.subscriptions')
      : createLegacyWebSocket(
        websocketUrl(resolved.avalancheEndpoint, resolved.apiKey, '/ava-ws'),
      )
    : createDirectWebSocket(
      resolved.avalancheCRpc,
      'avalanche.subscriptions',
    )

  const createUnavailableRest = (namespace: string) =>
    new RestTransport({
      endpoint: unavailableEndpoint(namespace),
      fetch: resolved.fetch,
      headers: {},
      timeoutMs: resolved.timeoutMs,
      unavailableNamespace: namespace,
    })

  const priceTransport = resolved.apiKey === undefined
    ? createUnavailableRest('price')
    : new RestTransport({ ...legacyTransport, endpoint: resolved.endpoint })
  const accountTransport = resolved.apiKey === undefined
    ? createUnavailableRest('account')
    : new RestTransport({
      ...legacyTransport,
      endpoint: resolved.accountEndpoint,
    })
  const userTransport = resolved.apiKey === undefined
    ? createUnavailableRest('usage')
    : new RestTransport({ ...legacyTransport, endpoint: resolved.userEndpoint })

  const solana: ErpcSolanaClient = {
    ...createSolanaClient(solanaTransport),
    subscriptions: new SolanaSubscriptions(solanaWebSocket),
  }
  const ethereum: ErpcEthereumClient = {
    ...createEthereumClient(ethereumTransport),
    subscriptions: new EthereumSubscriptions(ethereumWebSocket),
  }
  const avalanche: ErpcAvalancheClient = {
    ...createAvalancheClient(avalancheTransport, {
      cChainBlocks: avalancheIndexTransport(
        '/ava/ext/index/C/block',
        'avalanche.index.cChainBlocks',
      ),
      pChainBlocks: avalancheIndexTransport(
        '/ava/ext/index/P/block',
        'avalanche.index.pChainBlocks',
      ),
      xChainBlocks: avalancheIndexTransport(
        '/ava/ext/index/X/block',
        'avalanche.index.xChainBlocks',
      ),
      xChainTransactions: avalancheIndexTransport(
        '/ava/ext/index/X/tx',
        'avalanche.index.xChainTransactions',
      ),
    }, avalancheNativeTransport),
    subscriptions: new EthereumSubscriptions(avalancheWebSocket),
  }
  const swap = createSwapClient({
    ethereum: ethereumTransport,
    avalanche: avalancheTransport,
  })

  return {
    solana,
    ethereum,
    avalanche,
    arbitrum: createArbitrumClient(arbitrumTransport),
    base: createBaseClient(baseTransport),
    bitcoin: createBitcoinClient(bitcoinTransport),
    bsc: createBscClient(bscTransport),
    arc: createArcClient(arcTransport),
    hyperliquid: createHyperliquidClient(hyperliquidTransport),
    kaia: createKaiaClient(kaiaTransport),
    monad: createMonadClient(monadTransport),
    optimism: createOptimismClient(optimismTransport),
    polygon: createPolygonClient(polygonTransport),
    soneium: createSoneiumClient(soneiumTransport),
    robinhood: createRobinhoodClient(robinhoodTransport),
    near: createNearClient(nearTransport),
    sui: createSuiClient(suiTransport),
    tron: createTronClient(tronTransport),
    price: new PriceClient(priceTransport),
    account: new AccountClient(accountTransport),
    swap,
    usage: new UsageClient(userTransport),
    close: () => {
      solana.subscriptions.close()
      ethereum.subscriptions.close()
      avalanche.subscriptions.close()
    },
  }
}
