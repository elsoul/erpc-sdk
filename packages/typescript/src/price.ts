import { ErpcInvalidResponseError } from './errors'
import type { RpcSendOptions } from './rpc/types'
import type { Query } from './transport/rest'
import { RestTransport } from './transport/rest'

export type PriceEncoding = 'base64' | 'hex'
export type PriceAssetType = 'crypto' | 'equity' | 'fx' | 'metal' | 'rates'

export interface PriceFeedMetadata {
  readonly attributes?: Readonly<Record<string, string>>
  readonly id: string
}

export interface PricePoint {
  readonly conf: string
  readonly expo: number
  readonly price: string
  readonly publish_time: number
}

export interface ParsedPriceUpdate {
  readonly ema_price: PricePoint
  readonly id: string
  readonly metadata?: {
    readonly prev_publish_time?: number
    readonly proof_available_time?: number
    readonly slot?: number
  }
  readonly price: PricePoint
}

export interface BinaryUpdate {
  readonly data: readonly string[]
  readonly encoding: string
}

export interface PriceUpdateResponse {
  readonly binary: BinaryUpdate
  readonly parsed?: readonly ParsedPriceUpdate[]
}

export interface PriceUpdateOptions {
  readonly encoding?: PriceEncoding
  readonly ids: readonly string[]
  readonly ignoreInvalidPriceIds?: boolean
  readonly parsed?: boolean
}

export interface PriceStreamOptions extends PriceUpdateOptions {
  readonly allowUnordered?: boolean
  readonly benchmarksOnly?: boolean
}

export interface PublisherStakeCap {
  readonly cap: number
  readonly publisher: string
}

export interface PublisherStakeCapsResponse {
  readonly binary: BinaryUpdate
  readonly parsed?: readonly {
    readonly publisher_stake_caps: readonly PublisherStakeCap[]
  }[]
}

export interface PriceStreamEvent {
  readonly data: PriceUpdateResponse
  readonly event?: string
  readonly id?: string
}

const updateQuery = (options: PriceUpdateOptions): Query => ({
  'ids[]': options.ids,
  encoding: options.encoding,
  parsed: options.parsed,
  ignore_invalid_price_ids: options.ignoreInvalidPriceIds,
})

const parseSseBlock = (block: string): PriceStreamEvent | null => {
  const data: string[] = []
  let event: string | undefined
  let id: string | undefined

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const raw = separator === -1 ? '' : line.slice(separator + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
  }

  if (data.length === 0) return null
  let parsed: PriceUpdateResponse
  try {
    parsed = JSON.parse(data.join('\n')) as PriceUpdateResponse
  } catch {
    throw new ErpcInvalidResponseError('ERPC returned malformed stream data')
  }
  const result: {
    data: PriceUpdateResponse
    event?: string
    id?: string
  } = { data: parsed }
  if (event !== undefined) result.event = event
  if (id !== undefined) result.id = id
  return result
}

export class PriceClient {
  readonly #transport: RestTransport

  constructor(transport: RestTransport) {
    this.#transport = transport
  }

  getPriceFeeds(
    options: {
      readonly assetType?: PriceAssetType
      readonly query?: string
    } = {},
    sendOptions?: RpcSendOptions,
  ): Promise<readonly PriceFeedMetadata[]> {
    return this.#transport.get(
      '/v2/price_feeds',
      { query: options.query, asset_type: options.assetType },
      sendOptions,
    )
  }

  getLatestPriceUpdates(
    options: PriceUpdateOptions,
    sendOptions?: RpcSendOptions,
  ): Promise<PriceUpdateResponse> {
    return this.#transport.get(
      '/v2/updates/price/latest',
      updateQuery(options),
      sendOptions,
    )
  }

  getPriceUpdatesAtTimestamp(
    publishTime: number | string,
    options: PriceUpdateOptions,
    sendOptions?: RpcSendOptions,
  ): Promise<PriceUpdateResponse> {
    return this.#transport.get(
      `/v2/updates/price/${encodeURIComponent(String(publishTime))}`,
      updateQuery(options),
      sendOptions,
    )
  }

  getLatestPublisherStakeCaps(
    options: { readonly encoding?: PriceEncoding; readonly parsed?: boolean } = {},
    sendOptions?: RpcSendOptions,
  ): Promise<PublisherStakeCapsResponse> {
    return this.#transport.get(
      '/v2/updates/publisher_stake_caps/latest',
      options,
      sendOptions,
    )
  }

  async *streamPriceUpdates(
    options: PriceStreamOptions,
    sendOptions?: RpcSendOptions,
  ): AsyncGenerator<PriceStreamEvent, void, undefined> {
    const stream = await this.#transport.stream(
      '/v2/updates/price/stream',
      {
        ...updateQuery(options),
        allow_unordered: options.allowUnordered,
        benchmarks_only: options.benchmarksOnly,
      },
      sendOptions,
    )
    const response = stream.response
    if (!response.body) {
      stream.close()
      throw new ErpcInvalidResponseError('ERPC returned an empty stream')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        let boundary = buffer.search(/\r?\n\r?\n/)
        while (boundary !== -1) {
          const separatorLength = buffer.slice(boundary).startsWith('\r\n')
            ? 4
            : 2
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + separatorLength)
          const event = parseSseBlock(block)
          if (event) yield event
          boundary = buffer.search(/\r?\n\r?\n/)
        }
        if (done) break
      }
      const finalEvent = parseSseBlock(buffer)
      if (finalEvent) yield finalEvent
    } catch (error) {
      throw stream.normalizeError(error)
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Preserve the original stream result or error.
      } finally {
        reader.releaseLock()
        stream.close()
      }
    }
  }
}
