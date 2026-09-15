import { describe, expect, it } from 'vitest'
import {
  AVALANCHE_AVAX_METHODS,
  AVALANCHE_INDEX_METHODS,
  AVALANCHE_INFO_METHODS,
  AVALANCHE_P_CHAIN_METHODS,
  AVALANCHE_PROPOSER_VM_METHODS,
  AVALANCHE_X_CHAIN_METHODS,
  createErpcClient,
  ErpcBatchPolicyError,
  ErpcInvalidResponseError,
  ErpcJsonRpcError,
  ErpcTransportError,
  ETHEREUM_RPC_METHODS,
  ETHEREUM_SUBSCRIPTION_METHODS,
  SOLANA_ANALYTICS_METHODS,
  SOLANA_DAS_METHODS,
  SOLANA_ENHANCED_SUBSCRIPTION_METHODS,
  SOLANA_HISTORY_METHODS,
  SOLANA_LEADER_METHODS,
  SOLANA_RPC_METHODS,
} from '../src'

const rpcFetch = (
  requests: Array<{ readonly body: unknown; readonly url: string }>,
): typeof globalThis.fetch =>
  async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as
      | Record<string, unknown>[]
      | Record<string, unknown>
    requests.push({ url, body })

    const respond = (request: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id: request.id,
      result:
        request.method === 'getSlot'
          ? 123
          : request.method === 'getHealth'
            ? 'ok'
            : request.method === 'eth_chainId'
              ? url.includes('ava-rpc')
                ? '0xa86a'
                : '0x1'
              : request.params ?? null,
    })
    const response = Array.isArray(body)
      ? [...body].reverse().map(respond)
      : respond(body)
    return new Response(JSON.stringify(response), {
      headers: { 'content-type': 'application/json' },
    })
  }

const capturedCalls = (
  requests: readonly { readonly body: unknown; readonly url: string }[],
): readonly { readonly method: string; readonly params?: unknown }[] =>
  requests.map(({ body }) => {
    const request = body as {
      readonly method: string
      readonly params?: unknown
    }
    return { method: request.method, params: request.params }
  })

describe('ERPC client', () => {
  it('routes Solana, Ethereum, and Avalanche calls from one client', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    await expect(client.solana.rpc.getSlot().send()).resolves.toBe(123)
    await expect(
      client.solana.das.getAsset({ id: 'asset-id' }).send(),
    ).resolves.toEqual({ id: 'asset-id' })
    await expect(client.ethereum.rpc.eth_chainId().send()).resolves.toBe('0x1')
    await expect(client.avalanche.rpc.eth_chainId().send()).resolves.toBe(
      '0xa86a',
    )

    expect(requests).toHaveLength(4)
    expect(requests[0]?.url).toBe(
      'https://edge.erpc.global/?api-key=test-secret',
    )
    expect(requests[1]?.body).toMatchObject({
      method: 'getAsset',
      params: { id: 'asset-id' },
    })
    expect(requests[2]?.url).toBe(
      'https://edge.erpc.global/eth?api-key=test-secret',
    )
    expect(requests[3]?.url).toBe(
      'https://ava-rpc.erpc.global/ava?api-key=test-secret',
    )
    expect(client.solana.rpc.endpoint).not.toContain('test-secret')
    expect(client.ethereum.rpc.endpoint).not.toContain('test-secret')
    expect(client.avalanche.rpc.endpoint).not.toContain('test-secret')
  })

  it('forwards every getTransaction and getBlock option with integer v1 opt-in', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })
    const transactionOptions = {
      commitment: 'finalized',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
    }
    const blockOptions = {
      commitment: 'confirmed',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 1,
      rewards: true,
      transactionDetails: 'full',
    }

    await client.solana.rpc
      .getTransaction('signature-v1', transactionOptions)
      .send()
    await client.solana.rpc.getBlock(1035, blockOptions).send()

    expect(capturedCalls(requests)).toEqual([
      {
        method: 'getTransaction',
        params: ['signature-v1', transactionOptions],
      },
      {
        method: 'getBlock',
        params: [1035, blockOptions],
      },
    ])
    expect(transactionOptions.maxSupportedTransactionVersion).toBe(1)
    expect(typeof transactionOptions.maxSupportedTransactionVersion).toBe(
      'number',
    )
    expect(blockOptions.maxSupportedTransactionVersion).toBe(1)
    expect(typeof blockOptions.maxSupportedTransactionVersion).toBe('number')
  })

  it('preserves explicit zero and omitted transaction-version options', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    await client.solana.rpc
      .getTransaction('signature-v0', { maxSupportedTransactionVersion: 0 })
      .send()
    await client.solana.rpc.getTransaction('signature-legacy').send()
    await client.solana.rpc
      .getBlock(1034, { maxSupportedTransactionVersion: 0 })
      .send()
    await client.solana.rpc.getBlock(1033).send()

    expect(capturedCalls(requests)).toEqual([
      {
        method: 'getTransaction',
        params: ['signature-v0', { maxSupportedTransactionVersion: 0 }],
      },
      { method: 'getTransaction', params: ['signature-legacy'] },
      {
        method: 'getBlock',
        params: [1034, { maxSupportedTransactionVersion: 0 }],
      },
      { method: 'getBlock', params: [1033] },
    ])
  })

  it('preserves complete v1 responses and absent legacy/v0 transaction config', async () => {
    const version1Transaction = {
      slot: 1035,
      transaction: {
        signatures: ['signature-v1'],
        message: {
          accountKeys: ['payer', 'program'],
          header: {
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 1,
            numRequiredSignatures: 1,
          },
          instructions: [{ accounts: [1], data: 'AQI=', programIdIndex: 1 }],
          recentBlockhash: 'blockhash-v1',
          transactionConfig: {
            computeUnitLimit: 30000,
            loadedAccountsDataSizeLimit: 200000,
            heapSize: null,
            priorityFee: null,
          },
          unrelatedMessageField: { keep: true },
        },
        unrelatedTransactionField: 'preserved',
      },
      meta: { err: null, fee: 5000, unrelatedMetaField: ['preserved'] },
      version: 1,
      blockTime: null,
      unrelatedRootField: { keep: true },
    }
    const legacyTransaction = {
      transaction: {
        message: {
          accountKeys: ['legacy-payer'],
          instructions: [],
          recentBlockhash: 'blockhash-legacy',
        },
        signatures: ['signature-legacy'],
      },
      meta: null,
      version: 'legacy',
    }
    const v0Transaction = {
      transaction: {
        message: {
          accountKeys: ['v0-payer'],
          addressTableLookups: [],
          instructions: [],
          recentBlockhash: 'blockhash-v0',
        },
        signatures: ['signature-v0'],
      },
      meta: null,
      version: 0,
    }
    const version1BlockTransaction = {
      ...version1Transaction,
      transaction: {
        ...version1Transaction.transaction,
        message: {
          ...version1Transaction.transaction.message,
          transactionConfig: {
            ...version1Transaction.transaction.message.transactionConfig,
            priorityFee: 5000,
          },
        },
      },
    }
    const block = {
      blockhash: 'blockhash-v1',
      previousBlockhash: 'blockhash-parent',
      parentSlot: 1034,
      transactions: [
        version1BlockTransaction,
        legacyTransaction,
        v0Transaction,
      ],
      rewards: [],
      unrelatedBlockField: 'preserved',
    }
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          readonly id: number
          readonly method: string
        }
        const result =
          request.method === 'getBlock' ? block : version1Transaction
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result }),
          { headers: { 'content-type': 'application/json' } },
        )
      },
    })

    const transaction = await client.solana.rpc
      .getTransaction('signature-v1', { maxSupportedTransactionVersion: 1 })
      .send()
    const confirmedBlock = await client.solana.rpc
      .getBlock(1035, { maxSupportedTransactionVersion: 1 })
      .send()

    expect(transaction).toEqual(version1Transaction)
    expect(confirmedBlock).toEqual(block)
    expect(version1Transaction.transaction.message.transactionConfig).toEqual({
      computeUnitLimit: 30000,
      loadedAccountsDataSizeLimit: 200000,
      heapSize: null,
      priorityFee: null,
    })
    expect(
      version1BlockTransaction.transaction.message.transactionConfig.priorityFee,
    ).toBe(5000)
    expect(legacyTransaction.transaction.message).not.toHaveProperty(
      'transactionConfig',
    )
    expect(v0Transaction.transaction.message).not.toHaveProperty(
      'transactionConfig',
    )
  })

  it('forwards one identical 4096-byte base64 fixture to send and simulate', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })
    // Synthetic opaque fixture: it is an invalid signed transaction and only
    // proves that the SDK forwards the exact bytes and encoding option.
    const invalidSignedTransactionFixture = 'A'.repeat(5462) + '=='
    expect(invalidSignedTransactionFixture).toBe(
      Buffer.alloc(4096).toString('base64'),
    )
    expect(Buffer.from(invalidSignedTransactionFixture, 'base64')).toHaveLength(
      4096,
    )
    const options = { encoding: 'base64' }

    await client.solana.rpc
      .sendTransaction(invalidSignedTransactionFixture, options)
      .send()
    await client.solana.rpc
      .simulateTransaction(invalidSignedTransactionFixture, options)
      .send()

    expect(requests).toHaveLength(2)
    expect(capturedCalls(requests)).toEqual([
      {
        method: 'sendTransaction',
        params: [invalidSignedTransactionFixture, options],
      },
      {
        method: 'simulateTransaction',
        params: [invalidSignedTransactionFixture, options],
      },
    ])
  })

  it('surfaces one -32015 error with data without retry or fallback', async () => {
    let requestCount = 0
    const errorData = {
      maxSupportedTransactionVersion: 0,
      transactionVersion: 1,
      detail: 'decoder capability is too old',
    }
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async (_input, init) => {
        requestCount += 1
        const request = JSON.parse(String(init?.body)) as {
          readonly id: number
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32015,
              message: 'Transaction version is not supported',
              data: errorData,
            },
          }),
        )
      },
    })

    const error = await client.solana.rpc
      .getTransaction('signature-v1', { maxSupportedTransactionVersion: 0 })
      .send()
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(error).toMatchObject({ rpcCode: -32015, data: errorData })
    expect(requestCount).toBe(1)
  })

  it('routes Avalanche native and index namespaces with wire-compatible names', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    await client.avalanche.avax
      .getAtomicTxStatus({ txID: 'tx-id' })
      .send()
    await client.avalanche.xChain.getHeight().send()
    await client.avalanche.pChain.getCurrentValidators({}).send()
    await client.avalanche.proposerVm.getCurrentEpoch().send()
    await client.avalanche.info.upgrades().send()
    await client.avalanche.index.xChainTransactions
      .getContainerByID({ id: 'tx-id' })
      .send()
    await client.avalanche.pChain.raw('platform.futureMethod', {}).send()

    expect(requests.map(({ body }) => body)).toEqual([
      expect.objectContaining({
        method: 'avax.getAtomicTxStatus',
        params: { txID: 'tx-id' },
      }),
      expect.objectContaining({ method: 'avm.getHeight' }),
      expect.objectContaining({
        method: 'platform.getCurrentValidators',
        params: {},
      }),
      expect.objectContaining({ method: 'proposervm.getCurrentEpoch' }),
      expect.objectContaining({ method: 'info.upgrades' }),
      expect.objectContaining({
        method: 'index.getContainerByID',
        params: { id: 'tx-id' },
      }),
      expect.objectContaining({ method: 'platform.futureMethod', params: {} }),
    ])
    expect(requests[5]?.url).toBe(
      'https://ava-rpc.erpc.global/ava/ext/index/X/tx?api-key=test-secret',
    )
  })

  it('rejects Avalanche native batches before transport', () => {
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch([]),
    })

    expect(() =>
      client.avalanche.xChain.batch([
        { method: 'getHeight' },
      ] as const),
    ).toThrowError(ErpcBatchPolicyError)
  })

  it('exports the complete Avalanche native method catalogs', () => {
    expect([
      ...AVALANCHE_AVAX_METHODS,
      ...AVALANCHE_X_CHAIN_METHODS,
      ...AVALANCHE_P_CHAIN_METHODS,
      ...AVALANCHE_PROPOSER_VM_METHODS,
      ...AVALANCHE_INFO_METHODS,
      ...AVALANCHE_INDEX_METHODS,
    ]).toHaveLength(50)
  })

  it('restores batch results to request order', async () => {
    const requests: Array<{ readonly body: unknown; readonly url: string }> = []
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch(requests),
    })

    const result = await client.solana.rpc
      .batch([
        { method: 'getSlot', params: [] },
        { method: 'getHealth', params: [] },
      ] as const)
      .send()

    expect(result).toEqual([123, 'ok'])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toHaveLength(2)
  })

  it.each([
    {
      name: 'duplicate',
      alter: (responses: readonly Record<string, unknown>[]) => [
        responses[0],
        responses[0],
      ],
      message: 'ERPC returned duplicate batch response id',
    },
    {
      name: 'missing',
      alter: (responses: readonly Record<string, unknown>[]) => [responses[0]],
      message: 'ERPC omitted batch response id',
    },
    {
      name: 'unexpected',
      alter: (responses: readonly Record<string, unknown>[]) => [
        ...responses,
        { jsonrpc: '2.0', id: 'test-secret', result: null },
      ],
      message: 'ERPC returned an unexpected batch response id',
    },
  ])('rejects $name batch response ids', async ({ alter, message }) => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async (_input, init) => {
        fetchCount += 1
        const requests = JSON.parse(String(init?.body)) as readonly Record<
          string,
          unknown
        >[]
        const responses = requests.map((request) => ({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method,
        }))
        return new Response(JSON.stringify(alter(responses)))
      },
    })

    const error = await client.solana.rpc
      .batch([
        { method: 'getSlot', params: [] },
        { method: 'getHealth', params: [] },
      ] as const)
      .send()
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ErpcInvalidResponseError)
    expect(error).toMatchObject({ code: 'ERPC_INVALID_RESPONSE' })
    expect(String(error)).toContain(message)
    expect(String(error)).not.toContain('test-secret')
    expect(fetchCount).toBe(1)
  })

  it('returns an empty batch without making a request', async () => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async () => {
        fetchCount += 1
        return new Response('[]')
      },
    })

    await expect(client.solana.rpc.batch([]).send()).resolves.toEqual([])
    expect(fetchCount).toBe(0)
  })

  it('rejects batches larger than 256 calls without making a request', async () => {
    let fetchCount = 0
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: async () => {
        fetchCount += 1
        return new Response('[]')
      },
    })
    const calls = Array.from({ length: 257 }, () => ({
      method: 'getSlot' as const,
      params: [] as const,
    }))

    await expect(client.solana.rpc.batch(calls).send()).rejects.toBeInstanceOf(
      ErpcInvalidResponseError,
    )
    expect(fetchCount).toBe(0)
  })

  it('rejects mixed indexed and standard Solana batches locally', () => {
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch([]),
    })

    expect(() =>
      client.solana.rpc.batch([
        { method: 'getProgramAccounts', params: ['program'] },
        { method: 'getSlot', params: [] },
      ] as const),
    ).toThrow(ErpcBatchPolicyError)
  })

  it('rejects leader batches locally', () => {
    const client = createErpcClient({
      apiKey: 'test-secret',
      fetch: rpcFetch([]),
    })

    expect(() =>
      client.solana.leaders.batch([
        { method: 'getLeaderSlots', params: [0] },
      ] as const),
    ).toThrow(ErpcBatchPolicyError)
  })

  it('surfaces JSON-RPC errors without exposing the credential', async () => {
    const client = createErpcClient({
      apiKey: 'never-show-this',
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { readonly id: number }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32601,
              message: 'Method not found for never-show-this',
              data: {
                url: 'https://edge.erpc.global/?api-key=never-show-this',
              },
            },
          }),
        )
      },
    })

    const error = await client.solana.rpc.getSlot().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcJsonRpcError)
    expect(String(error)).not.toContain('never-show-this')
    expect(JSON.stringify(error.data)).not.toContain('never-show-this')
  })

  it('does not retain credential-bearing fetch errors as a cause', async () => {
    const client = createErpcClient({
      apiKey: 'never-retain-this',
      fetch: async (input) => {
        throw new Error(`Unable to fetch ${String(input)}`)
      },
    })

    const error = await client.solana.rpc.getSlot().send().catch((value) => value)
    expect(error).toBeInstanceOf(ErpcTransportError)
    expect(error.cause).toBeUndefined()
    expect(String(error)).not.toContain('never-retain-this')
  })

  it('publishes the complete current method catalogs', () => {
    expect(SOLANA_RPC_METHODS).toHaveLength(55)
    expect(SOLANA_DAS_METHODS).toHaveLength(14)
    expect(SOLANA_HISTORY_METHODS).toHaveLength(2)
    expect(SOLANA_LEADER_METHODS).toHaveLength(2)
    expect(SOLANA_ANALYTICS_METHODS).toHaveLength(5)
    expect(SOLANA_ENHANCED_SUBSCRIPTION_METHODS).toHaveLength(4)
    expect(ETHEREUM_RPC_METHODS).toHaveLength(53)
    expect(ETHEREUM_SUBSCRIPTION_METHODS).toHaveLength(2)

    const all = [
      ...SOLANA_RPC_METHODS,
      ...SOLANA_DAS_METHODS,
      ...SOLANA_HISTORY_METHODS,
      ...SOLANA_LEADER_METHODS,
      ...SOLANA_ANALYTICS_METHODS,
    ]
    expect(new Set(all)).toHaveLength(all.length)
  })
})
