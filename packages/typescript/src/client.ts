import { AccountClient } from './account'
import {
  endpointWithPath,
  resolveConfig,
  websocketUrl,
  type ErpcClientConfig,
} from './config'
import { PriceClient } from './price'
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

export interface ErpcSolanaClient extends SolanaClient {
  readonly subscriptions: SolanaSubscriptions
}

export interface ErpcEthereumClient extends EthereumClient {
  readonly subscriptions: EthereumSubscriptions
}

export interface ErpcClient {
  readonly account: AccountClient
  readonly ethereum: ErpcEthereumClient
  readonly price: PriceClient
  readonly solana: ErpcSolanaClient
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

  const priceTransport = new RestTransport({
    ...sharedTransport,
    endpoint: resolved.endpoint,
  })
  const accountTransport = new RestTransport({
    ...sharedTransport,
    endpoint: resolved.accountEndpoint,
  })

  const solana: ErpcSolanaClient = {
    ...createSolanaClient(solanaTransport),
    subscriptions: new SolanaSubscriptions(solanaWebSocket),
  }
  const ethereum: ErpcEthereumClient = {
    ...createEthereumClient(ethereumTransport),
    subscriptions: new EthereumSubscriptions(ethereumWebSocket),
  }

  return {
    solana,
    ethereum,
    price: new PriceClient(priceTransport),
    account: new AccountClient(accountTransport),
    close: () => {
      solana.subscriptions.close()
      ethereum.subscriptions.close()
    },
  }
}
