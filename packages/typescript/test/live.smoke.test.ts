import { afterAll, describe, expect, it } from 'vitest'
import { createErpcClient } from '../src'

const apiKey = process.env.ERPC_API_KEY
const live = describe.skipIf(!apiKey)
const client = apiKey ? createErpcClient({ apiKey }) : undefined

live('live ERPC smoke tests', () => {
  afterAll(() => client?.close())

  it('reads both RPC networks', async () => {
    const slot = await client?.solana.rpc.getSlot().send()
    const chainId = await client?.ethereum.rpc.eth_chainId().send()

    expect(slot).toBeTypeOf('number')
    expect(chainId).toMatch(/^0x[0-9a-f]+$/i)
  })

  it('reads price metadata and account balance', async () => {
    const feeds = await client?.price.getPriceFeeds({ query: 'btc' })
    const balance = await client?.account.getTokenBalance()

    expect(Array.isArray(feeds)).toBe(true)
    expect(balance?.remaining_tokens).toBeTypeOf('number')
  })

  it('reads masked monthly API key usage', async () => {
    const usage = await client?.usage.getMonthlyApiKeyUsage()

    expect(usage?.yearMonth).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/)
    expect(usage?.totalCount).toBeTypeOf('number')
    expect(Array.isArray(usage?.apiKeys)).toBe(true)
  })
})
