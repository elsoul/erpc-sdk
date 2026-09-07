import { AccountClient } from './account'
import {
  endpointWithPath,
  resolveConfig,
  websocketUrl,
  type ErpcClientConfig,
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
  readonly usage: UsageClient
  close(): void
}

export const createErpcClient = (config: ErpcClientConfig): ErpcClient => {
  const resolved = resolveConfig(config)
  const sharedTransport = {
    apiKey: resolved.apiKey,
    fetch: resolved.fetch,
    headers: resolved.headers,
    timeoutMs: resolved.timeoutMs,
  }

  const solanaTransport = new HttpJsonRpcTransport({
    ...sharedTransport,
    endpoint: resolved.endpoint,
  })
  const ethereumEndpoint = endpointWithPath(resolved.endpoint, '/eth')
  const ethereumTransport = new HttpJsonRpcTransport({
    ...sharedTransport,
    endpoint: ethereumEndpoint,
  })
  const avalancheTransport = new HttpJsonRpcTransport({
    ...sharedTransport,
    endpoint: endpointWithPath(resolved.avalancheEndpoint, '/ava'),
  })
  const avalancheIndexTransport = (path: string) =>
    new HttpJsonRpcTransport({
      ...sharedTransport,
      endpoint: endpointWithPath(resolved.avalancheEndpoint, path),
    })

  const solanaWebSocket = new WebSocketJsonRpcTransport({
    endpoint: websocketUrl(resolved.endpoint, resolved.apiKey),
    timeoutMs: resolved.timeoutMs,
    ...(resolved.webSocket === undefined
      ? {}
      : { webSocket: resolved.webSocket }),
  })
  const ethereumWebSocket = new WebSocketJsonRpcTransport({
    endpoint: websocketUrl(resolved.endpoint, resolved.apiKey, '/eth'),
    timeoutMs: resolved.timeoutMs,
    ...(resolved.webSocket === undefined
      ? {}
      : { webSocket: resolved.webSocket }),
  })
  const avalancheWebSocket = new WebSocketJsonRpcTransport({
    endpoint: websocketUrl(
      resolved.avalancheEndpoint,
      resolved.apiKey,
      '/ava-ws',
    ),
    timeoutMs: resolved.timeoutMs,
    ...(resolved.webSocket === undefined
      ? {}
      : { webSocket: resolved.webSocket }),
  })

  const priceTransport = new RestTransport({
    ...sharedTransport,
    endpoint: resolved.endpoint,
  })
  const accountTransport = new RestTransport({
    ...sharedTransport,
    endpoint: resolved.accountEndpoint,
  })
  const userTransport = new RestTransport({
    ...sharedTransport,
    endpoint: resolved.userEndpoint,
  })

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
      cChainBlocks: avalancheIndexTransport('/ava/ext/index/C/block'),
      pChainBlocks: avalancheIndexTransport('/ava/ext/index/P/block'),
      xChainBlocks: avalancheIndexTransport('/ava/ext/index/X/block'),
      xChainTransactions: avalancheIndexTransport('/ava/ext/index/X/tx'),
    }),
    subscriptions: new EthereumSubscriptions(avalancheWebSocket),
  }

  return {
    solana,
    ethereum,
    avalanche,
    price: new PriceClient(priceTransport),
    account: new AccountClient(accountTransport),
    usage: new UsageClient(userTransport),
    close: () => {
      solana.subscriptions.close()
      ethereum.subscriptions.close()
      avalanche.subscriptions.close()
    },
  }
}
