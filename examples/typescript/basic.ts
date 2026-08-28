import { createErpcClient } from '@elsoul/erpc-sdk'

const apiKey = process.env.ERPC_API_KEY
if (!apiKey) throw new Error('ERPC_API_KEY is required')

const erpc = createErpcClient({ apiKey })

const [slot, chainId, tokenBalance] = await Promise.all([
  erpc.solana.rpc.getSlot().send(),
  erpc.ethereum.rpc.eth_chainId().send(),
  erpc.account.getTokenBalance(),
])

console.log({ slot, chainId, tokenBalance })
erpc.close()
