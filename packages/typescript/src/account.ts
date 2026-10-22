import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'

export type ErpcPlan = 'business' | 'developer' | 'free' | 'pro'

export interface TokenBalance {
  readonly max_tokens: number
  readonly next_refill_at: string | null
  readonly plan: ErpcPlan
  readonly remaining_tokens: number
}

export class AccountClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  getTokenBalance(options?: RpcSendOptions): Promise<TokenBalance> {
    return this.#transport.get('/v3/erpc/token-balance', undefined, options)
  }
}
