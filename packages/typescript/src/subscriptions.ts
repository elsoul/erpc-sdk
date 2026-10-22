import { createRpcNamespace, type RpcNamespace } from './rpc/client'
import type { EthereumSubscriptionSchema } from './rpc/ethereum'
import type { RpcMethodSpec } from './rpc/types'
import {
  WebSocketJsonRpcTransport,
  type RpcNotification,
  type RpcNotificationListener,
} from './transport/websocket'

export type SubscriptionId = number | string
export type SubscriptionListener<TResult> = (result: TResult) => void

interface NotificationParams {
  readonly result: unknown
  readonly subscription: SubscriptionId
}

const notificationParams = (
  notification: RpcNotification,
): NotificationParams | null => {
  if (typeof notification.params !== 'object' || notification.params === null) {
    return null
  }
  const params = notification.params as Record<string, unknown>
  if (
    (typeof params.subscription !== 'number' &&
      typeof params.subscription !== 'string') ||
    !('result' in params)
  ) {
    return null
  }
  return {
    subscription: params.subscription,
    result: params.result,
  }
}

export class RpcSubscription<TId extends SubscriptionId = SubscriptionId> {
  readonly id: TId
  readonly #unsubscribe: () => Promise<boolean>
  #closed = false

  constructor(id: TId, unsubscribe: () => Promise<boolean>) {
    this.id = id
    this.#unsubscribe = unsubscribe
  }

  async unsubscribe(): Promise<boolean> {
    if (this.#closed) return true
    const result = await this.#unsubscribe()
    if (result) this.#closed = true
    return result
  }
}

export class EthereumSubscriptions {
  readonly rpc: RpcNamespace<EthereumSubscriptionSchema>
  readonly #transport: WebSocketJsonRpcTransport

  constructor(transport: WebSocketJsonRpcTransport) {
    this.#transport = transport
    this.rpc = createRpcNamespace<EthereumSubscriptionSchema>({
      transport,
      parameterMode: 'positional',
    })
  }

  close(): void {
    this.#transport.close()
  }

  onNotification(listener: RpcNotificationListener): () => void {
    return this.#transport.onNotification(listener)
  }

  async subscribe<TResult = unknown>(
    subscription: string,
    listener: SubscriptionListener<TResult>,
    ...options: readonly unknown[]
  ): Promise<RpcSubscription<string>> {
    let id: string | undefined
    const removeListener = this.#transport.onNotification((notification) => {
      const params = notificationParams(notification)
      if (params && params.subscription === id) listener(params.result as TResult)
    })

    try {
      id = await this.#transport.request<string>('eth_subscribe', [
        subscription,
        ...options,
      ])
    } catch (error) {
      removeListener()
      throw error
    }

    return new RpcSubscription(id, async () => {
      const result = await this.#transport.request<boolean>('eth_unsubscribe', [
        id,
      ])
      if (result) removeListener()
      return result
    })
  }
}

export interface SolanaEnhancedSubscriptionSchema {
  readonly accountSubscribe: RpcMethodSpec<
    readonly [address: string, options?: Readonly<Record<string, unknown>>],
    number
  >
  readonly accountUnsubscribe: RpcMethodSpec<
    readonly [subscriptionId: number],
    boolean
  >
  readonly transactionSubscribe: RpcMethodSpec<
    readonly [
      filter: Readonly<Record<string, unknown>>,
      options?: Readonly<Record<string, unknown>>,
    ],
    number
  >
  readonly transactionUnsubscribe: RpcMethodSpec<
    readonly [subscriptionId: number],
    boolean
  >
}

export const SOLANA_ENHANCED_SUBSCRIPTION_METHODS = [
  'accountSubscribe',
  'accountUnsubscribe',
  'transactionSubscribe',
  'transactionUnsubscribe',
] as const satisfies readonly (keyof SolanaEnhancedSubscriptionSchema)[]

export class SolanaSubscriptions {
  readonly rpc: RpcNamespace<SolanaEnhancedSubscriptionSchema>
  readonly #transport: WebSocketJsonRpcTransport

  constructor(transport: WebSocketJsonRpcTransport) {
    this.#transport = transport
    this.rpc = createRpcNamespace<SolanaEnhancedSubscriptionSchema>({
      transport,
      parameterMode: 'positional',
    })
  }

  close(): void {
    this.#transport.close()
  }

  onNotification(listener: RpcNotificationListener): () => void {
    return this.#transport.onNotification(listener)
  }

  accountSubscribe<TResult = unknown>(
    address: string,
    listener: SubscriptionListener<TResult>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<RpcSubscription<number>> {
    const params = options === undefined ? [address] : [address, options]
    return this.#subscribe<number, TResult>(
      'accountSubscribe',
      params,
      'accountUnsubscribe',
      listener,
    )
  }

  transactionSubscribe<TResult = unknown>(
    filter: Readonly<Record<string, unknown>>,
    listener: SubscriptionListener<TResult>,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<RpcSubscription<number>> {
    const params = options === undefined ? [filter] : [filter, options]
    return this.#subscribe<number, TResult>(
      'transactionSubscribe',
      params,
      'transactionUnsubscribe',
      listener,
    )
  }

  async rawSubscribe<TResult = unknown>(
    subscribeMethod: string,
    params: readonly unknown[],
    unsubscribeMethod: string,
    listener: SubscriptionListener<TResult>,
  ): Promise<RpcSubscription> {
    return this.#subscribe(
      subscribeMethod,
      params,
      unsubscribeMethod,
      listener,
    )
  }

  async #subscribe<TId extends SubscriptionId, TResult>(
    subscribeMethod: string,
    params: readonly unknown[],
    unsubscribeMethod: string,
    listener: SubscriptionListener<TResult>,
  ): Promise<RpcSubscription<TId>> {
    let id: TId | undefined
    const removeListener = this.#transport.onNotification((notification) => {
      const value = notificationParams(notification)
      if (value && value.subscription === id) listener(value.result as TResult)
    })

    try {
      id = await this.#transport.request<TId>(subscribeMethod, params)
    } catch (error) {
      removeListener()
      throw error
    }

    return new RpcSubscription(id, async () => {
      const result = await this.#transport.request<boolean>(unsubscribeMethod, [
        id,
      ])
      if (result) removeListener()
      return result
    })
  }
}
