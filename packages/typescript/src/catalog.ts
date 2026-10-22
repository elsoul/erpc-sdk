import { ErpcInvalidResponseError } from './errors'
import type { CloudResourceKind, CloudResourceMode } from './resources'
import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'

export interface CloudOfferingBilling {
  readonly amountCents: number
  readonly unit: 'cents-per-hour'
}

export interface CloudOfferingCompute {
  readonly tenancy: 'bare-metal' | 'virtual-machine'
}

export interface CloudOfferingSolana {
  readonly transport: 'grpc' | 'shredstream'
}

export interface CloudOffering {
  readonly billing?: CloudOfferingBilling
  readonly capabilities: readonly string[]
  readonly compute?: CloudOfferingCompute
  readonly description: string
  readonly id: string
  readonly kind: CloudResourceKind
  readonly mode?: CloudResourceMode
  readonly name: string
  readonly regions: readonly string[]
  readonly solana?: CloudOfferingSolana
}

const resourceKinds: readonly CloudResourceKind[] = [
  'bare-metal',
  'solana-grpc',
  'solana-shredstream',
  'vps',
]
const resourceModes: readonly CloudResourceMode[] = [
  'dedicated',
  'direct',
  'shared',
]

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null

const stringArray = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null

const parseOffering = (value: unknown): CloudOffering | null => {
  const offering = objectValue(value)
  if (
    offering === null ||
    typeof offering.id !== 'string' ||
    typeof offering.kind !== 'string' ||
    !resourceKinds.includes(offering.kind as CloudResourceKind) ||
    typeof offering.name !== 'string' ||
    typeof offering.description !== 'string' ||
    (offering.mode !== undefined &&
      (typeof offering.mode !== 'string' ||
        !resourceModes.includes(offering.mode as CloudResourceMode)))
  ) return null

  const regions = stringArray(offering.regions)
  const capabilities = stringArray(offering.capabilities)
  if (regions === null || capabilities === null) return null

  const compute = offering.compute === undefined
    ? undefined
    : objectValue(offering.compute)
  if (
    compute !== undefined &&
    (compute === null ||
      (compute.tenancy !== 'virtual-machine' &&
        compute.tenancy !== 'bare-metal'))
  ) return null

  const solana = offering.solana === undefined
    ? undefined
    : objectValue(offering.solana)
  if (
    solana !== undefined &&
    (solana === null ||
      (solana.transport !== 'grpc' && solana.transport !== 'shredstream'))
  ) return null

  const billing = offering.billing === undefined
    ? undefined
    : objectValue(offering.billing)
  if (
    billing !== undefined &&
    (billing === null ||
      billing.unit !== 'cents-per-hour' ||
      typeof billing.amountCents !== 'number' ||
      !Number.isInteger(billing.amountCents) ||
      billing.amountCents < 0)
  ) return null

  return {
    id: offering.id,
    kind: offering.kind as CloudResourceKind,
    name: offering.name,
    description: offering.description,
    regions,
    capabilities,
    ...(typeof offering.mode === 'string'
      ? { mode: offering.mode as CloudResourceMode }
      : {}),
    ...(compute &&
        (compute.tenancy === 'virtual-machine' || compute.tenancy === 'bare-metal')
      ? { compute: { tenancy: compute.tenancy } }
      : {}),
    ...(solana &&
        (solana.transport === 'grpc' || solana.transport === 'shredstream')
      ? { solana: { transport: solana.transport } }
      : {}),
    ...(billing &&
        billing.unit === 'cents-per-hour' &&
        typeof billing.amountCents === 'number'
      ? {
        billing: {
          amountCents: billing.amountCents,
          unit: billing.unit,
        },
      }
      : {}),
  }
}

export class CloudCatalogClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  async list(options?: RpcSendOptions): Promise<readonly CloudOffering[]> {
    const response: unknown = await this.#transport.get(
      '/v4/cloud/catalog',
      undefined,
      options,
    )
    const envelope = objectValue(response)
    const message = objectValue(envelope?.message)
    if (envelope?.success !== true || !Array.isArray(message?.offerings)) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud catalog',
      )
    }
    const offerings = message.offerings.map(parseOffering)
    if (offerings.some((offering) => offering === null)) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud catalog',
      )
    }
    return offerings as readonly CloudOffering[]
  }
}
