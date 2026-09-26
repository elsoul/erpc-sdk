import { afterAll, describe, expect, it } from 'vitest'
import { createErpcClient, getTokenDeployment, tokens } from '../src'

const apiKey = process.env.ERPC_API_KEY
const live = describe.skipIf(!apiKey)
const client = apiKey ? createErpcClient({ apiKey }) : undefined
const baseRpcUrl = process.env.ERPC_BASE_RPC_URL?.trim()
const baseLive = describe.skipIf(!apiKey && !baseRpcUrl)
const baseClient = baseRpcUrl
  ? createErpcClient({ baseRpc: { httpUrl: baseRpcUrl } })
  : apiKey
    ? createErpcClient({ apiKey })
    : undefined

const BASE_WALLET = '0x7A5837f5bB52C53e08fcFf214c2Cd11daa8EF9EE'
const BASE_EURC = '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42'
const BASE_PINNED_BLOCK = '0x3167564'
const ERC20_BALANCE_OF = '0x70a08231'
const BALANCE_OF_CALLDATA = `${ERC20_BALANCE_OF}${BASE_WALLET.slice(2).padStart(64, '0')}`
const BASE_EURC_DEPLOYMENT = getTokenDeployment(tokens.base.EURC)
const EXPECTED_PINNED_EURC_ATOMIC = 5_500_000n
const expectedLatestEurcAtomic = process.env.ERPC_BASE_EXPECTED_EURC_ATOMIC

const formatUnits = (value: bigint, decimals: number): string => {
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/u, '')
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`
}

live('live ERPC smoke tests', () => {
  afterAll(() => client?.close())

  it('reads every RPC network', async () => {
    const slot = await client?.solana.rpc.getSlot().send()
    const chainId = await client?.ethereum.rpc.eth_chainId().send()
    const avalancheChainId = await client?.avalanche.rpc.eth_chainId().send()

    expect(slot).toBeTypeOf('number')
    expect(chainId).toMatch(/^0x[0-9a-f]+$/i)
    expect(avalancheChainId).toBe('0xa86a')
  })

  it('reads Avalanche P-Chain and X-Chain native APIs', async () => {
    const pChainHeight = await client?.avalanche.pChain.getHeight().send()
    const xChainHeight = await client?.avalanche.xChain.getHeight().send()

    expect(pChainHeight).toHaveProperty('height')
    expect(xChainHeight).toHaveProperty('height')
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

baseLive('live Base read-only smoke tests', () => {
  afterAll(() => baseClient?.close())

  it('checks Base identity and reads the pinned public balances', async () => {
    const chainId = await baseClient?.base.rpc.eth_chainId().send()
    const ethBalance = await baseClient?.base.rpc
      .eth_getBalance(BASE_WALLET, BASE_PINNED_BLOCK)
      .send()
    const eurcBalance = await baseClient?.base.rpc
      .eth_call(
        { to: BASE_EURC, data: BALANCE_OF_CALLDATA },
        BASE_PINNED_BLOCK,
      )
      .send()

    expect(chainId).toBe('0x2105')
    expect(ethBalance).toBe('0x0')
    expect(BASE_EURC_DEPLOYMENT).toMatchObject({
      symbol: 'EURC',
      decimals: 6,
      address: BASE_EURC,
    })
    const rawBalance = BigInt(eurcBalance ?? '0x0')
    expect(rawBalance).toBe(EXPECTED_PINNED_EURC_ATOMIC)
    expect(formatUnits(rawBalance, BASE_EURC_DEPLOYMENT?.decimals ?? 0)).toBe('5.5')
  })

  it.skipIf(expectedLatestEurcAtomic === undefined)(
    'checks the mutable latest balance against an explicit atomic expectation',
    async () => {
      const latest = await baseClient?.base.rpc
        .eth_call(
          { to: BASE_EURC, data: BALANCE_OF_CALLDATA },
          'latest',
        )
        .send()
      const rawLatest = BigInt(latest ?? '0x0')
      expect(rawLatest).toBe(BigInt(expectedLatestEurcAtomic!))
    },
  )
})
