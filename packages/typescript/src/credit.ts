import { ErpcInvalidResponseError } from './errors'
import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'

export type CloudCreditAlertLevel =
  | 'critical'
  | 'normal'
  | 'suspended'
  | 'warning'

export interface CloudCredit {
  readonly alertLevel: CloudCreditAlertLevel
  readonly balanceCents: number
  readonly burnRateCentsPerHour: number
  readonly quoteExpiresAt: string
  readonly quoteTimestamp: string
  readonly timeToZeroHours: number | null
}

const alertLevels: readonly CloudCreditAlertLevel[] = [
  'critical',
  'normal',
  'suspended',
  'warning',
]

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null

const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const parseCredit = (value: unknown): CloudCredit | null => {
  const credit = objectValue(value)
  if (
    credit === null ||
    typeof credit.balanceCents !== 'number' ||
    !Number.isInteger(credit.balanceCents) ||
    typeof credit.burnRateCentsPerHour !== 'number' ||
    !Number.isInteger(credit.burnRateCentsPerHour) ||
    credit.burnRateCentsPerHour < 0 ||
    (credit.timeToZeroHours !== null &&
      (typeof credit.timeToZeroHours !== 'number' ||
        !Number.isFinite(credit.timeToZeroHours) ||
        credit.timeToZeroHours < 0)) ||
    typeof credit.alertLevel !== 'string' ||
    !alertLevels.includes(credit.alertLevel as CloudCreditAlertLevel) ||
    !isDateTime(credit.quoteTimestamp) ||
    !isDateTime(credit.quoteExpiresAt)
  ) return null

  return {
    alertLevel: credit.alertLevel as CloudCreditAlertLevel,
    balanceCents: credit.balanceCents,
    burnRateCentsPerHour: credit.burnRateCentsPerHour,
    quoteExpiresAt: credit.quoteExpiresAt,
    quoteTimestamp: credit.quoteTimestamp,
    timeToZeroHours: credit.timeToZeroHours,
  }
}

export class CloudCreditClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  async get(options?: RpcSendOptions): Promise<CloudCredit> {
    const response: unknown = await this.#transport.get(
      '/v4/cloud/credit',
      undefined,
      options,
    )
    const envelope = objectValue(response)
    const credit = envelope?.success === true
      ? parseCredit(envelope.message)
      : null
    if (credit === null) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud credit snapshot',
      )
    }
    return credit
  }
}
