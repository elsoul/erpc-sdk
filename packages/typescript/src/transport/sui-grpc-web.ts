import {
  ErpcAbortedError,
  ErpcHttpError,
  ErpcInvalidResponseError,
  ErpcNotConfiguredError,
  ErpcTimeoutError,
  ErpcTransportError,
} from '../errors'
import { RPC_NETWORK_CONTRACT } from '../generated/rpc_network_contract'
import {
  SUI_RESPONSE_LIMIT,
  SUI_TRAILER_LIMIT,
} from './sui-proto'
import type { RpcSendOptions } from '../rpc/types'
import { wrapFetch } from './fetch'

export const SUI_GRPC_WEB_CONTENT_TYPE = 'application/grpc-web+proto'
interface GeneratedCapability {
  readonly publicOperation: string
  readonly wireOperation: string
}
interface GeneratedMethodSet {
  readonly methodSetId: string
  readonly capabilities?: readonly GeneratedCapability[]
}
interface GeneratedContract { readonly methodSets: readonly GeneratedMethodSet[] }
const generatedMethodSet = (RPC_NETWORK_CONTRACT as unknown as GeneratedContract).methodSets
  .find((candidate) => candidate.methodSetId === 'sui-unary3')
if (generatedMethodSet?.capabilities === undefined) throw new Error('Missing generated Sui method set')
const generatedMethod = (publicOperation: string): string => {
  const method = generatedMethodSet.capabilities?.find(
    (candidate) => candidate.publicOperation === publicOperation,
  )?.wireOperation
  if (method === undefined) throw new Error(`Missing generated Sui method: ${publicOperation}`)
  return method
}
export const SUI_GRPC_WEB_METHODS = Object.freeze([
  generatedMethod('getServiceInfo'),
  generatedMethod('getObject'),
  generatedMethod('getBalance'),
] as const)

export interface SuiGrpcWebTransportConfig {
  readonly apiKey?: string
  readonly direct?: boolean
  readonly endpoint: URL
  readonly fetch: typeof globalThis.fetch
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly unavailableNamespace?: string
}

const controlledSignal = (timeoutMs: number, external?: AbortSignal) => {
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
): Record<string, string> => Object.fromEntries(
  Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
)

const requestHeaders = (
  direct: boolean,
  headers: Readonly<Record<string, string>>,
  apiKey: string,
): Headers => {
  const result = direct
    ? { ...headers }
    : { ...withoutAuthorization(headers), authorization: `Bearer ${apiKey}` }
  const normalized = new Headers(result)
  normalized.set('content-type', SUI_GRPC_WEB_CONTENT_TYPE)
  normalized.set('accept', SUI_GRPC_WEB_CONTENT_TYPE)
  normalized.set('x-grpc-web', '1')
  return normalized
}

const appendMethod = (base: URL, method: string): URL => {
  const url = new URL(base)
  const prefix = url.pathname.replace(/\/+$/u, '')
  url.pathname = `${prefix}${method}` || method
  return url
}

const frameLength = (body: Uint8Array, offset: number): number => {
  if (offset + 5 > body.byteLength) throw new ErpcInvalidResponseError('Sui response framing is invalid')
  const length = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(offset + 1, false)
  if (offset + 5 + length > body.byteLength) throw new ErpcInvalidResponseError('Sui response framing is invalid')
  return length
}

const validHeaderName = (value: string): boolean =>
  value.length > 0 && [...value].every((character) => /[a-z\d!#$%&'*+\-.^_`|~]/u.test(character))

const trimHorizontalWhitespace = (value: string): string =>
  value.replace(/^[ \t]+|[ \t]+$/gu, '')

const validateTrailer = (payload: Uint8Array): void => {
  if (payload.byteLength > SUI_TRAILER_LIMIT) throw new ErpcInvalidResponseError('Sui response trailer is too large')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload) } catch { throw new ErpcInvalidResponseError('Sui response trailer is invalid') }
  if (!text.endsWith('\r\n')) throw new ErpcInvalidResponseError('Sui response trailer is invalid')
  let statusCount = 0
  for (const line of text.split('\r\n').slice(0, -1)) {
    const separator = line.indexOf(':')
    if (separator <= 0) throw new ErpcInvalidResponseError('Sui response trailer is invalid')
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!validHeaderName(name) || [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return (code < 0x20 && code !== 0x09) || code === 0x7f
    })) throw new ErpcInvalidResponseError('Sui response trailer is invalid')
    if (name === 'grpc-status') {
      statusCount += 1
      if (statusCount !== 1 || trimHorizontalWhitespace(value) !== '0') throw new ErpcInvalidResponseError('Sui response status is invalid')
    }
  }
  if (statusCount !== 1) throw new ErpcInvalidResponseError('Sui response status is missing')
}

const extractDataFrame = (body: Uint8Array): Uint8Array => {
  if (body.byteLength < 10 || body[0] !== 0) throw new ErpcInvalidResponseError('Sui response framing is invalid')
  const dataLength = frameLength(body, 0)
  const trailerOffset = 5 + dataLength
  if (trailerOffset >= body.byteLength || body[trailerOffset] !== 0x80) throw new ErpcInvalidResponseError('Sui response framing is invalid')
  const trailerLength = frameLength(body, trailerOffset)
  if (trailerOffset + 5 + trailerLength !== body.byteLength) throw new ErpcInvalidResponseError('Sui response framing is invalid')
  validateTrailer(body.slice(trailerOffset + 5))
  return body.slice(5, trailerOffset)
}

const readBody = async (response: Response, signal: AbortSignal): Promise<Uint8Array> => {
  if (response.body === null) {
    const value = new Uint8Array(await response.arrayBuffer())
    if (value.byteLength > SUI_RESPONSE_LIMIT) throw new ErpcInvalidResponseError('Sui response is too large')
    return value
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let settled = false
  let rejectAbort: ((reason?: unknown) => void) | undefined
  let cancelPromise: Promise<void> | undefined
  const cancel = (): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise
    cancelPromise = reader.cancel().catch(() => undefined)
    return cancelPromise
  }
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject })
  const abort = () => {
    if (settled) return
    rejectAbort?.(new Error('aborted'))
    void cancel()
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abortPromise])
      if (signal.aborted) throw new Error('aborted')
      if (next.done) break
      const chunk = next.value
      if (chunk.byteLength > SUI_RESPONSE_LIMIT - total) {
        await cancel()
        throw new ErpcInvalidResponseError('Sui response is too large')
      }
      total += chunk.byteLength
      chunks.push(chunk)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return body
  } catch (error) {
    await cancel()
    if (error instanceof ErpcInvalidResponseError) throw error
    throw error
  } finally {
    settled = true
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export class SuiGrpcWebTransport {
  readonly endpoint: string
  readonly #apiKey: string
  readonly #direct: boolean
  readonly #baseUrl: URL
  readonly #fetch: typeof globalThis.fetch
  readonly #headers: Readonly<Record<string, string>>
  readonly #timeoutMs: number
  readonly #unavailableNamespace: string | undefined

  constructor(config: SuiGrpcWebTransportConfig) {
    this.#apiKey = config.apiKey ?? ''
    this.#direct = config.direct ?? false
    this.#baseUrl = new URL(config.endpoint)
    this.#fetch = wrapFetch(config.fetch)
    this.#headers = config.headers
    this.#timeoutMs = config.timeoutMs
    this.#unavailableNamespace = config.unavailableNamespace
    const diagnostic = new URL(config.endpoint)
    diagnostic.pathname = '/'
    diagnostic.search = ''
    diagnostic.hash = ''
    this.endpoint = config.unavailableNamespace === undefined ? diagnostic.toString() : ''
  }

  async execute(method: string, body: Uint8Array, options: RpcSendOptions = {}): Promise<Uint8Array> {
    this.#ensureConfigured()
    if (options.signal?.aborted) throw new ErpcAbortedError()
    const controlled = controlledSignal(this.#timeoutMs, options.signal)
    try {
      const response = await this.#fetch(appendMethod(this.#baseUrl, method), {
        method: 'POST',
        headers: requestHeaders(this.#direct, this.#headers, this.#apiKey),
        body: body as unknown as BodyInit,
        signal: controlled.signal,
        credentials: 'omit',
        redirect: 'manual',
      })
      if (response.status !== 200) {
        try { await response.body?.cancel() } catch { /* preserve HTTP category */ }
        throw new ErpcHttpError(response.status)
      }
      const contentType = response.headers.get('content-type')
      if (contentType !== SUI_GRPC_WEB_CONTENT_TYPE) {
        try { await response.body?.cancel() } catch { /* preserve invalid-response category */ }
        throw new ErpcInvalidResponseError('Sui response content type is invalid')
      }
      return extractDataFrame(await readBody(response, controlled.signal))
    } catch (error) {
      if (error instanceof ErpcHttpError || error instanceof ErpcInvalidResponseError) throw error
      if (controlled.timedOut()) throw new ErpcTimeoutError(this.#timeoutMs)
      if (options.signal?.aborted) throw new ErpcAbortedError()
      throw new ErpcTransportError('Unable to reach Sui gRPC-Web endpoint')
    } finally { controlled.cleanup() }
  }

  #ensureConfigured(): void {
    if (this.#unavailableNamespace !== undefined) throw new ErpcNotConfiguredError(this.#unavailableNamespace)
  }
}
