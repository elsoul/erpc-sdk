import { PendingRpcRequest, type JsonRpcTransport } from './client'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import type {
  EthereumAddress,
  EthereumBlockTag,
  EthereumObject,
  Hex,
} from './ethereum'

interface GeneratedCapability { readonly wireOperation: string }
interface GeneratedMethodSet {
  readonly methodSetId: string
  readonly capabilities?: readonly GeneratedCapability[]
}
interface GeneratedContract { readonly methodSets: readonly GeneratedMethodSet[] }

const methodSet = (RPC_NETWORK_CONTRACT as unknown as GeneratedContract).methodSets
  .find((candidate) => candidate.methodSetId === 'sealed-evm-read3')
if (methodSet?.capabilities === undefined) throw new Error('Missing generated sealed EVM method set')

export const HYPERLIQUID_RPC_METHODS = Object.freeze(
  methodSet.capabilities.map(({ wireOperation }) => wireOperation),
)

const hyperliquidMethod = (index: number): string => {
  const method = HYPERLIQUID_RPC_METHODS[index]
  if (method === undefined) throw new Error('Missing generated Hyperliquid method')
  return method
}

export interface HyperliquidRpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
}

export interface HyperliquidReadRpcClient {
  readonly endpoint: string
  eth_chainId(): PendingRpcRequest<Hex>
  eth_getBalance(address: EthereumAddress, block?: EthereumBlockTag): PendingRpcRequest<Hex>
  eth_call(transaction: EthereumObject, block?: EthereumBlockTag, stateOverride?: EthereumObject): PendingRpcRequest<Hex>
}

export interface ErpcHyperliquidClient { readonly rpc: HyperliquidReadRpcClient }

const request = <TResult>(transport: JsonRpcTransport, method: string, params: readonly unknown[]): PendingRpcRequest<TResult> =>
  new PendingRpcRequest((options) => transport.request<TResult>(method, params, options))

export const createHyperliquidClient = (transport: JsonRpcTransport): ErpcHyperliquidClient => ({
  rpc: {
    endpoint: transport.endpoint,
    eth_chainId: () => request<Hex>(transport, hyperliquidMethod(1), []),
    eth_getBalance: (address, block) => request<Hex>(transport, hyperliquidMethod(2), [address, ...(block === undefined ? [] : [block])]),
    eth_call: (transaction, block, stateOverride) => request<Hex>(transport, hyperliquidMethod(0), [transaction, ...(block === undefined ? [] : [block]), ...(stateOverride === undefined ? [] : [stateOverride])]),
  },
})
