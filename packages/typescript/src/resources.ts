import { ErpcConfigError, ErpcInvalidResponseError } from './errors'
import type { RpcSendOptions } from './rpc/types'
import { RestTransport } from './transport/rest'

export type CloudResourceKind =
  | 'bare-metal'
  | 'solana-grpc'
  | 'solana-shredstream'
  | 'vps'

export type CloudResourceMode = 'dedicated' | 'direct' | 'shared'

/** A credential-free projection of an ERPC Cloud resource. */
export interface CloudResource {
  readonly createdAt?: string
  readonly id: string
  readonly kind: CloudResourceKind
  readonly mode?: CloudResourceMode
  readonly name?: string
  readonly region?: string
  readonly status: string
}

export interface CloudResourceStatusBilling {
  readonly graceEndsAt?: string
  readonly hourlyCredits?: number
  readonly nextChargeAt?: string
  readonly status: 'active' | 'grace-period' | 'inactive' | 'suspended'
}

export interface CloudResourceStatus {
  readonly billing?: CloudResourceStatusBilling
  readonly id: string
  readonly status: string
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null

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
const billingStatuses: readonly CloudResourceStatusBilling['status'][] = [
  'active',
  'grace-period',
  'inactive',
  'suspended',
]

const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const parseStatusBilling = (
  value: unknown,
): CloudResourceStatusBilling | null => {
  const billing = objectValue(value)
  if (
    billing === null ||
    typeof billing.status !== 'string' ||
    !billingStatuses.includes(
      billing.status as CloudResourceStatusBilling['status'],
    ) ||
    (billing.hourlyCredits !== undefined &&
      (typeof billing.hourlyCredits !== 'number' ||
        !Number.isFinite(billing.hourlyCredits) ||
        billing.hourlyCredits < 0)) ||
    (billing.nextChargeAt !== undefined &&
      !isDateTime(billing.nextChargeAt)) ||
    (billing.graceEndsAt !== undefined &&
      !isDateTime(billing.graceEndsAt))
  ) return null

  return {
    status: billing.status as CloudResourceStatusBilling['status'],
    ...(typeof billing.hourlyCredits === 'number'
      ? { hourlyCredits: billing.hourlyCredits }
      : {}),
    ...(typeof billing.nextChargeAt === 'string'
      ? { nextChargeAt: billing.nextChargeAt }
      : {}),
    ...(typeof billing.graceEndsAt === 'string'
      ? { graceEndsAt: billing.graceEndsAt }
      : {}),
  }
}

const parseResourceStatus = (value: unknown): CloudResourceStatus | null => {
  const status = objectValue(value)
  if (
    status === null ||
    typeof status.id !== 'string' ||
    typeof status.status !== 'string'
  ) return null
  const billing = status.billing === undefined
    ? undefined
    : parseStatusBilling(status.billing)
  if (status.billing !== undefined && billing === null) return null
  return {
    id: status.id,
    status: status.status,
    ...(billing ? { billing } : {}),
  }
}
const parseResource = (value: unknown): CloudResource | null => {
  const resource = objectValue(value)
  if (
    resource === null ||
    typeof resource.id !== 'string' ||
    typeof resource.kind !== 'string' ||
    !resourceKinds.includes(resource.kind as CloudResourceKind) ||
    typeof resource.status !== 'string' ||
    (resource.mode !== undefined &&
      (typeof resource.mode !== 'string' ||
        !resourceModes.includes(resource.mode as CloudResourceMode))) ||
    (resource.name !== undefined && typeof resource.name !== 'string') ||
    (resource.region !== undefined && typeof resource.region !== 'string') ||
    (resource.createdAt !== undefined && typeof resource.createdAt !== 'string')
  ) return null

  return {
    id: resource.id,
    kind: resource.kind as CloudResourceKind,
    status: resource.status,
    ...(typeof resource.mode === 'string'
      ? { mode: resource.mode as CloudResourceMode }
      : {}),
    ...(typeof resource.name === 'string' ? { name: resource.name } : {}),
    ...(typeof resource.region === 'string' ? { region: resource.region } : {}),
    ...(typeof resource.createdAt === 'string'
      ? { createdAt: resource.createdAt }
      : {}),
  }
}

export class CloudResourcesClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  async list(options?: RpcSendOptions): Promise<readonly CloudResource[]> {
    const response: unknown = await this.#transport.get(
      '/v4/cloud/resources',
      undefined,
      options,
    )
    const envelope = objectValue(response)
    const message = objectValue(envelope?.message)
    if (envelope?.success !== true || !Array.isArray(message?.resources)) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud resource list',
      )
    }
    const resources = message.resources.map(parseResource)
    if (resources.some((resource) => resource === null)) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud resource list',
      )
    }
    return resources as readonly CloudResource[]
  }

  async get(
    resourceId: string,
    options?: RpcSendOptions,
  ): Promise<CloudResource> {
    const normalizedId = resourceId.trim()
    if (!normalizedId) {
      throw new ErpcConfigError('resourceId must not be empty')
    }
    const response: unknown = await this.#transport.get(
      `/v4/cloud/resources/${encodeURIComponent(normalizedId)}`,
      undefined,
      options,
    )
    const envelope = objectValue(response)
    const message = objectValue(envelope?.message)
    const resource = envelope?.success === true
      ? parseResource(message?.resource)
      : null
    if (resource === null) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud resource',
      )
    }
    return resource
  }

  async getStatus(
    resourceId: string,
    options?: RpcSendOptions,
  ): Promise<CloudResourceStatus> {
    const normalizedId = resourceId.trim()
    if (!normalizedId) {
      throw new ErpcConfigError('resourceId must not be empty')
    }
    const response: unknown = await this.#transport.get(
      `/v4/cloud/resources/${encodeURIComponent(normalizedId)}/status`,
      undefined,
      options,
    )
    const envelope = objectValue(response)
    const status = envelope?.success === true
      ? parseResourceStatus(envelope.message)
      : null
    if (status === null) {
      throw new ErpcInvalidResponseError(
        'ERPC returned an invalid Cloud resource status',
      )
    }
    return status
  }
}
