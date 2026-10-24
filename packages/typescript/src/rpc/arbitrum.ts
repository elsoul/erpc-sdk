import { PendingRpcRequest, type JsonRpcTransport } from './client'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import type {
  EthereumAddress,
  EthereumBlockTag,
  EthereumObject,
  Hex,
} from './ethereum'

interface GeneratedCapability {
  readonly wireOperation: string
}

interface GeneratedMethodSet {
  readonly methodSetId: string
  readonly capabilities?: readonly GeneratedCapability[]
}

interface GeneratedContract {
  readonly methodSets: readonly GeneratedMethodSet[]
}

const generatedContract = RPC_NETWORK_CONTRACT as unknown as GeneratedContract
const methodSet = generatedContract.methodSets.find(
  (candidate) => candidate.methodSetId === 'sealed-evm-read3',
)
if (methodSet?.capabilities === undefined) {
  throw new Error('Missing generated sealed EVM method set')
}

export const ARBITRUM_RPC_METHODS = Object.freeze(
  methodSet.capabilities.map(({ wireOperation }) => wireOperation),
)

const arbitrumMethod = (index: number): string => {
  const method = ARBITRUM_RPC_METHODS[index]
  if (method === undefined) throw new Error('Missing generated Arbitrum method')
  return method
}

export interface ArbitrumRpcEndpointConfig {
  readonly headers?: Readonly<Record<string, string>>
  readonly httpUrl: string
}

export interface ArbitrumReadRpcClient {
  readonly endpoint: string
  eth_chainId(): PendingRpcRequest<Hex>
  eth_getBalance(
    address: EthereumAddress,
    block?: EthereumBlockTag,
  ): PendingRpcRequest<Hex>
  eth_call(
    transaction: EthereumObject,
    block?: EthereumBlockTag,
    stateOverride?: EthereumObject,
  ): PendingRpcRequest<Hex>
}

export interface ErpcArbitrumClient {
  readonly rpc: ArbitrumReadRpcClient
}

const request = <TResult>(
  transport: JsonRpcTransport,
  method: string,
  params: readonly unknown[],
): PendingRpcRequest<TResult> =>
  new PendingRpcRequest((options) =>
    transport.request<TResult>(method, params, options),
  )

export const createArbitrumClient = (
  transport: JsonRpcTransport,
): ErpcArbitrumClient => ({
  rpc: {
    endpoint: transport.endpoint,
    eth_chainId: () => request<Hex>(transport, arbitrumMethod(1), []),
    eth_getBalance: (address, block) =>
      request<Hex>(transport, arbitrumMethod(2), [
        address,
        ...(block === undefined ? [] : [block]),
      ]),
    eth_call: (transaction, block, stateOverride) =>
      request<Hex>(transport, arbitrumMethod(0), [
        transaction,
        ...(block === undefined ? [] : [block]),
        ...(stateOverride === undefined ? [] : [stateOverride]),
      ]),
  },
})
