import { AccountClient } from './account'
import {
  endpointWithPath,
  resolveConfig,
  websocketUrl,
  type ErpcClientConfig,
  type ResolvedRpcEndpointConfig,
} from './config'
import { PriceClient } from './price'
import {
  createAvalancheClient,
  type AvalancheClient,
} from './rpc/avalanche'
import {
  createEthereumClient,
  type EthereumClient,
} from './rpc/ethereum'
import { createSolanaClient, type SolanaClient } from './rpc/solana'
import {
  EthereumSubscriptions,
  SolanaSubscriptions,
} from './subscriptions'
import { createSwapClient, type SwapClient } from './swap'
import { HttpJsonRpcTransport } from './transport/http'
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
  readonly ethereum: ErpcEthereumClient
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

  const createLegacyHttp = (endpoint: URL) =>
    new HttpJsonRpcTransport({ ...legacyTransport, endpoint })

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
