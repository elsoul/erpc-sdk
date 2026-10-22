import type {
  JsonRpcParams,
  RpcBatchCall,
  RpcMethodSpec,
  RpcParams,
  RpcResult,
  RpcSendOptions,
} from './types'

export interface JsonRpcTransport {
  readonly endpoint: string
  readonly maxBatchSize: number

  batch<TResult extends readonly unknown[]>(
    calls: readonly RpcBatchCall[],
    options?: RpcSendOptions,
  ): Promise<TResult>

  request<TResult>(
    method: string,
    params?: JsonRpcParams,
    options?: RpcSendOptions,
  ): Promise<TResult>
}

export class PendingRpcRequest<TResult> {
  readonly #send: (options?: RpcSendOptions) => Promise<TResult>

  constructor(send: (options?: RpcSendOptions) => Promise<TResult>) {
    this.#send = send
  }

  send(options?: RpcSendOptions): Promise<TResult> {
    return this.#send(options)
  }
}

export class PendingRpcBatchRequest<TResult extends readonly unknown[]> {
  readonly #send: (options?: RpcSendOptions) => Promise<TResult>

  constructor(send: (options?: RpcSendOptions) => Promise<TResult>) {
    this.#send = send
  }

  send(options?: RpcSendOptions): Promise<TResult> {
    return this.#send(options)
  }
}

type SchemaConstraint<TSchema> = {
  readonly [TMethod in keyof TSchema]: RpcMethodSpec<
    JsonRpcParams | undefined,
    unknown
  >
}

type MethodName<TSchema> = Extract<keyof TSchema, string>

type MethodFunction<TSpec> = TSpec extends RpcMethodSpec<
  infer TParams,
  infer TResult
>
  ? TParams extends readonly unknown[]
    ? (...params: TParams) => PendingRpcRequest<TResult>
    : TParams extends object
      ? (params: TParams) => PendingRpcRequest<TResult>
      : () => PendingRpcRequest<TResult>
  : never

type BatchCall<TSchema> = {
  readonly [TMethod in MethodName<TSchema>]: RpcParams<
    TSchema[TMethod]
  > extends undefined
    ? { readonly method: TMethod; readonly params?: undefined }
    : {
        readonly method: TMethod
        readonly params: RpcParams<TSchema[TMethod]>
      }
}[MethodName<TSchema>]

type BatchResults<
  TSchema,
  TCalls extends readonly BatchCall<TSchema>[],
> = {
  readonly [TIndex in keyof TCalls]: TCalls[TIndex] extends {
    readonly method: infer TMethod
  }
    ? TMethod extends MethodName<TSchema>
      ? RpcResult<TSchema[TMethod]>
      : never
    : never
}

export interface RpcNamespaceBase<TSchema> {
  readonly endpoint: string

  batch<const TCalls extends readonly BatchCall<TSchema>[]>(
    calls: TCalls,
  ): PendingRpcBatchRequest<BatchResults<TSchema, TCalls>>

  raw<TResult = unknown>(
    method: string,
    params?: JsonRpcParams,
  ): PendingRpcRequest<TResult>

  request<TMethod extends MethodName<TSchema>>(
    method: TMethod,
    ...params: RpcParams<TSchema[TMethod]> extends undefined
      ? []
      : [params: RpcParams<TSchema[TMethod]>]
  ): PendingRpcRequest<RpcResult<TSchema[TMethod]>>
}

export type RpcNamespace<TSchema extends SchemaConstraint<TSchema>> =
  RpcNamespaceBase<TSchema> & {
    readonly [TMethod in MethodName<TSchema>]: MethodFunction<TSchema[TMethod]>
  }

export interface CreateRpcNamespaceConfig {
  readonly methodPrefix?: string
  readonly parameterMode: 'named' | 'positional'
  readonly transport: JsonRpcTransport
  readonly validateBatch?: (calls: readonly RpcBatchCall[]) => void
}

const methodParams = (
  mode: CreateRpcNamespaceConfig['parameterMode'],
  args: readonly unknown[],
): JsonRpcParams | undefined => {
  if (mode === 'positional') return args
  if (args.length === 0) return undefined
  return args[0] as object
}

export const createRpcNamespace = <
  TSchema extends SchemaConstraint<TSchema>,
>(config: CreateRpcNamespaceConfig): RpcNamespace<TSchema> => {
  const wireMethod = (method: string) =>
    config.methodPrefix === undefined
      ? method
      : `${config.methodPrefix}.${method}`

  const base: RpcNamespaceBase<TSchema> = {
    endpoint: config.transport.endpoint,
    batch: <const TCalls extends readonly BatchCall<TSchema>[]>(calls: TCalls) => {
      const wireCalls = (calls as readonly RpcBatchCall[]).map((call) => ({
        ...call,
        method: wireMethod(call.method),
      }))
      config.validateBatch?.(wireCalls)
      return new PendingRpcBatchRequest((options) =>
        config.transport.batch<BatchResults<TSchema, TCalls>>(
          wireCalls,
          options,
        ),
      )
    },
    raw: <TResult>(method: string, params?: JsonRpcParams) =>
      new PendingRpcRequest<TResult>((options) =>
        config.transport.request<TResult>(method, params, options),
      ),
    request: <TMethod extends MethodName<TSchema>>(
      method: TMethod,
      ...params: RpcParams<TSchema[TMethod]> extends undefined
        ? []
        : [params: RpcParams<TSchema[TMethod]>]
    ) =>
      new PendingRpcRequest<RpcResult<TSchema[TMethod]>>((options) =>
        config.transport.request<RpcResult<TSchema[TMethod]>>(
          wireMethod(method),
          params[0] as JsonRpcParams | undefined,
          options,
        ),
      ),
  }

  return new Proxy(base as RpcNamespace<TSchema>, {
    get(target, property, receiver) {
      if (typeof property !== 'string' || property in target) {
        return Reflect.get(target, property, receiver) as unknown
      }
      if (property === 'then') return undefined
      return (...args: readonly unknown[]) =>
        new PendingRpcRequest((options) =>
          config.transport.request(
            wireMethod(property),
            methodParams(config.parameterMode, args),
            options,
          ),
        )
    },
  })
}
