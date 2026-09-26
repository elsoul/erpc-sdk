import type { HttpJsonRpcTransport } from '../transport/http'
import {
  createEthereumClient,
  type EthereumClient,
} from './ethereum'

/**
 * Read-only Base JSON-RPC facade.
 *
 * The implementation deliberately selects only the three read methods from
 * the existing EVM namespace. The transport is still shared with the mature
 * Ethereum RPC implementation, while the public Base surface has no raw,
 * batch, subscription, signing, or broadcast entry points.
 */
export interface BaseReadRpcClient extends Pick<
  EthereumClient['rpc'],
  'endpoint' | 'eth_chainId' | 'eth_getBalance' | 'eth_call'
> {}

export interface ErpcBaseClient {
  readonly rpc: BaseReadRpcClient
}

export const createBaseClient = (
  transport: HttpJsonRpcTransport,
): ErpcBaseClient => {
  const ethereumRpc = createEthereumClient(transport).rpc
  return {
    rpc: {
      endpoint: ethereumRpc.endpoint,
      eth_chainId: ethereumRpc.eth_chainId,
      eth_getBalance: ethereumRpc.eth_getBalance,
      eth_call: ethereumRpc.eth_call,
    },
  }
}
