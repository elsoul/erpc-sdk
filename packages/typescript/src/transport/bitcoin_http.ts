import {
  directRedactionVariants,
  ErpcAbortedError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
} from '../errors'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import {
  BITCOIN_RESPONSE_LIMITS,
  decodeBitcoinJson,
  unwrapBitcoinRpcResponse,
  type BitcoinJsonValue,
  type BitcoinRedactionConfig,
} from '../rpc/bitcoin_codec'
import type { JsonRpcParams, RpcSendOptions } from '../rpc/types'
import { endpointWithPath } from '../config'
import { wrapFetch } from './fetch'

interface GeneratedEndpointMode {
  readonly mode: string
  readonly defaultTarget: string | null
}

interface GeneratedClientContract {
  readonly clientContractId: string
  readonly endpointModes: readonly GeneratedEndpointMode[]
}

interface GeneratedContract {
  readonly clientContracts: readonly GeneratedClientContract[]
}

const generatedContract = RPC_NETWORK_CONTRACT as unknown as GeneratedContract
const bitcoinHostedPath = (): string => {
  const client = generatedContract.clientContracts.find(
    (candidate) => candidate.clientContractId === 'client-bitcoin-rpc',
  )
  const target = client?.endpointModes.find((mode) => mode.mode === 'hosted')?.defaultTarget
  if (target === null || target === undefined) {
    throw new Error('Missing generated Bitcoin hosted target')
  }
  const path = new URL(target).pathname.replace(/^\/+|\/+$/gu, '')
  if (!path) throw new Error('Missing generated Bitcoin hosted path')
  return path
}

export interface BitcoinHttpTransportConfig {
  readonly apiKey?: string
  readonly direct?: boolean
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly unavailableNamespace?: string
}

interface ControlledSignal {
  readonly cleanup: () => void
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
}

const controlledSignal = (
  timeoutMs: number,
  external?: AbortSignal,
): ControlledSignal => {
  const controller = new AbortController()
  let didTimeOut = false
  const timeout = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)
  const abort = () => controller.abort()
  if (external?.aborted) controller.abort()
  else external?.addEventListener('abort', abort, { once: true })

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timeout)
      external?.removeEventListener('abort', abort)
    },
  }
}

const withoutAuthorization = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') continue
    result[name] = value
  }
  return result
}

const requestHeaders = (
  direct: boolean,
  headers: Readonly<Record<string, string>>,
  apiKey: string,
): Headers => {
  const result = direct
    ? { ...headers }
    : {
        ...withoutAuthorization(headers),
        authorization: `Bearer ${apiKey}`,
      }
  const normalized = new Headers(result)
  normalized.set('accept', 'application/json')
  normalized.set('content-type', 'application/json')
  return normalized
}

const readResponseBody = async (
  response: Response,
  signal: AbortSignal,
): Promise<string> => {
  if (response.body === null) return response.text()

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let byteLength = 0
  let didAbort = signal.aborted
  let settled = false
  let rejectAbort: (() => void) | undefined
  let cancelPromise: Promise<void> | undefined
  const cancel = (): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise
    cancelPromise = reader.cancel().catch(() => undefined)
    return cancelPromise
  }
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error('aborted'))
  })
  const abort = () => {
    if (settled) return
    didAbort = true
    rejectAbort?.()
    void cancel()
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()

  const decode = (value?: Uint8Array): string => {
    try {
      return value === undefined
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
    } catch {
      throw new ErpcInvalidResponseError()
    }
  }

  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise])
      if (didAbort) throw new Error('aborted')
      const { done, value } = next
      if (done) {
        chunks.push(decode())
        settled = true
        return chunks.join('')
      }
      if (byteLength + value.byteLength > BITCOIN_RESPONSE_LIMITS.maxBodyBytes) {
        await cancel()
        throw new ErpcInvalidResponseError()
      }
      byteLength += value.byteLength
      chunks.push(decode(value))
    }
  } catch (error) {
    await cancel()
    if (error instanceof ErpcInvalidResponseError) throw error
    if (signal.aborted) throw error
    throw error
  } finally {
    settled = true
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export class BitcoinHttpTransport {
  readonly endpoint: string

  readonly #apiKey: string
  readonly #direct: boolean
  readonly #requestEndpoint: URL
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeoutMs: number
  readonly #unavailableNamespace: string | undefined
  readonly #redactionVariants: readonly string[]
  #nextId = 1

  constructor(config: BitcoinHttpTransportConfig) {
    this.#apiKey = config.apiKey ?? ''
    this.#direct = config.direct ?? false
    this.#fetch = wrapFetch(config.fetch)
    this.#headers = config.headers
    this.#timeoutMs = config.timeoutMs
    this.#unavailableNamespace = config.unavailableNamespace

    this.#requestEndpoint = this.#direct
      ? new URL(config.endpoint)
      : endpointWithPath(config.endpoint, bitcoinHostedPath())
    if (!this.#direct) this.#requestEndpoint.searchParams.delete('api-key')

    const diagnostic = new URL(this.#requestEndpoint)
    diagnostic.pathname = '/'
    diagnostic.search = ''
    diagnostic.hash = ''
    this.endpoint = config.unavailableNamespace === undefined
      ? diagnostic.toString()
      : ''
    this.#redactionVariants = this.#direct
      ? directRedactionVariants(this.#requestEndpoint, this.#headers)
      : []
  }

  async request<TResult extends BitcoinJsonValue>(
    method: string,
    params?: JsonRpcParams,
    options: RpcSendOptions = {},
  ): Promise<TResult> {
    this.#ensureConfigured()
    const id = this.#nextId
    this.#nextId = id >= Number.MAX_SAFE_INTEGER ? 1 : id + 1
    const body: {
      readonly jsonrpc: '2.0'
      readonly id: number
      readonly method: string
      readonly params?: JsonRpcParams
    } = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    }
    const response = await this.#post(body, options)
    const redaction: BitcoinRedactionConfig = this.#direct
      ? { additionalCredentials: this.#redactionVariants }
      : { credential: this.#apiKey }
    return unwrapBitcoinRpcResponse<TResult>(response, id, redaction)
  }

  #ensureConfigured(): void {
    if (this.#unavailableNamespace !== undefined) {
      throw new ErpcNotConfiguredError(this.#unavailableNamespace)
    }
  }

  async #post(
    body: unknown,
    options: RpcSendOptions,
  ): Promise<BitcoinJsonValue> {
    this.#ensureConfigured()
    if (options.signal?.aborted) throw new ErpcAbortedError()
    const controlled = controlledSignal(this.#timeoutMs, options.signal)

    try {
      const response = await this.#fetch(this.#requestEndpoint, {
        method: 'POST',
        headers: requestHeaders(this.#direct, this.#headers, this.#apiKey),
        body: JSON.stringify(body),
        signal: controlled.signal,
        credentials: 'omit',
        redirect: 'manual',
      })
      if (!response.ok) {
        try {
          await response.body?.cancel()
        } catch {
          // Preserve the stable HTTP error category.
        }
        throw new ErpcHttpError(response.status)
      }
      const text = await readResponseBody(response, controlled.signal)
      return decodeBitcoinJson(text)
    } catch (error) {
      if (
        error instanceof ErpcHttpError ||
        error instanceof ErpcInvalidResponseError
      ) {
        throw error
      }
      if (controlled.timedOut()) throw new ErpcTimeoutError(this.#timeoutMs)
      if (options.signal?.aborted) throw new ErpcAbortedError()
      throw new ErpcTransportError('Unable to reach ERPC')
    } finally {
      controlled.cleanup()
    }
  }
}
