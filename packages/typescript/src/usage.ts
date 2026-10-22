import { ErpcConfigError, ErpcInvalidResponseError } from './errors'
import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'

export interface MonthlyApiKeyMethodUsage {
  readonly count: number
  readonly creditCost: number
  readonly credits: number
  readonly method: string
  readonly updatedAt: string | null
}

export interface MonthlyApiKeyChainUsage {
  readonly chain: string
  readonly count: number
  readonly credits: number
  readonly methods: readonly MonthlyApiKeyMethodUsage[]
  readonly updatedAt: string | null
}

export interface MonthlyApiKeyUsageEntry {
  readonly apiKeyLast4: string
  readonly apiKeyLength: number
  readonly chains: readonly MonthlyApiKeyChainUsage[]
  readonly count: number
  readonly credits: number
  readonly keyId: number | null
  readonly updatedAt: string | null
}

export interface MonthlyApiKeyUsage {
  readonly apiKeys: readonly MonthlyApiKeyUsageEntry[]
  readonly chains: readonly MonthlyApiKeyChainUsage[]
  readonly hasStrandedUsage: boolean
  readonly keyCount: number
  readonly totalCount: number
  readonly totalCredits: number
  readonly updatedAt: string | null
  readonly yearMonth: string
}

export interface MonthlyApiKeyUsageParams {
  /** Calendar month in `YYYY-MM` format. The current month is used when omitted. */
  readonly yearMonth?: string
}

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null

const isTimestamp = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const parseMethod = (value: unknown): MonthlyApiKeyMethodUsage | null => {
  const method = objectValue(value)
  if (
    method === null ||
    typeof method.count !== 'number' ||
    typeof method.creditCost !== 'number' ||
    typeof method.credits !== 'number' ||
    typeof method.method !== 'string' ||
    !isTimestamp(method.updatedAt)
  ) return null
  return {
    count: method.count,
    creditCost: method.creditCost,
    credits: method.credits,
    method: method.method,
    updatedAt: method.updatedAt,
  }
}

const parseChain = (value: unknown): MonthlyApiKeyChainUsage | null => {
  const chain = objectValue(value)
  if (
    chain === null ||
    typeof chain.chain !== 'string' ||
    typeof chain.count !== 'number' ||
    typeof chain.credits !== 'number' ||
    !Array.isArray(chain.methods) ||
    !isTimestamp(chain.updatedAt)
  ) return null
  const methods = chain.methods.map(parseMethod)
  if (methods.some((method) => method === null)) return null
  return {
    chain: chain.chain,
    count: chain.count,
    credits: chain.credits,
    methods: methods as readonly MonthlyApiKeyMethodUsage[],
    updatedAt: chain.updatedAt,
  }
}

const parseApiKey = (value: unknown): MonthlyApiKeyUsageEntry | null => {
  const apiKey = objectValue(value)
  if (
    apiKey === null ||
    typeof apiKey.apiKeyLast4 !== 'string' ||
    typeof apiKey.apiKeyLength !== 'number' ||
    !Array.isArray(apiKey.chains) ||
    typeof apiKey.count !== 'number' ||
    typeof apiKey.credits !== 'number' ||
    (apiKey.keyId !== null && typeof apiKey.keyId !== 'number') ||
    !isTimestamp(apiKey.updatedAt)
  ) return null
  const chains = apiKey.chains.map(parseChain)
  if (chains.some((chain) => chain === null)) return null
  return {
    apiKeyLast4: apiKey.apiKeyLast4,
    apiKeyLength: apiKey.apiKeyLength,
    chains: chains as readonly MonthlyApiKeyChainUsage[],
    count: apiKey.count,
    credits: apiKey.credits,
    keyId: apiKey.keyId,
    updatedAt: apiKey.updatedAt,
  }
}

const parseMonthlyUsage = (value: unknown): MonthlyApiKeyUsage | null => {
  const usage = objectValue(value)
  if (
    usage === null ||
    !Array.isArray(usage.apiKeys) ||
    !Array.isArray(usage.chains) ||
    typeof usage.hasStrandedUsage !== 'boolean' ||
    typeof usage.keyCount !== 'number' ||
    typeof usage.totalCount !== 'number' ||
    typeof usage.totalCredits !== 'number' ||
    !isTimestamp(usage.updatedAt) ||
    typeof usage.yearMonth !== 'string' ||
    !YEAR_MONTH.test(usage.yearMonth)
  ) return null
  const apiKeys = usage.apiKeys.map(parseApiKey)
  const chains = usage.chains.map(parseChain)
  if (
    apiKeys.some((apiKey) => apiKey === null) ||
    chains.some((chain) => chain === null)
  ) return null
  return {
    apiKeys: apiKeys as readonly MonthlyApiKeyUsageEntry[],
    chains: chains as readonly MonthlyApiKeyChainUsage[],
    hasStrandedUsage: usage.hasStrandedUsage,
    keyCount: usage.keyCount,
    totalCount: usage.totalCount,
    totalCredits: usage.totalCredits,
    updatedAt: usage.updatedAt,
    yearMonth: usage.yearMonth,
  }
}

export class UsageClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  async getMonthlyApiKeyUsage(
    params: MonthlyApiKeyUsageParams = {},
    options?: RpcSendOptions,
  ): Promise<MonthlyApiKeyUsage> {
    if (params.yearMonth !== undefined && !YEAR_MONTH.test(params.yearMonth)) {
      throw new ErpcConfigError('yearMonth must use YYYY-MM format')
    }

    const response: unknown = await this.#transport.get(
      '/v3/user/api-keys/usage',
      { yearMonth: params.yearMonth },
      options,
    )
    const envelope = objectValue(response)
    const usage = envelope?.success === true
      ? parseMonthlyUsage(envelope.message)
      : null
    if (usage === null) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid monthly API key usage response',
      )
    }
    return usage
  }
}
