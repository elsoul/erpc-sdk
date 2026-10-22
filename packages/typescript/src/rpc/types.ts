export type JsonPrimitive = boolean | null | number | string

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type JsonRpcId = number | string

export type JsonRpcParams = object | readonly unknown[]

export type RpcMethodSpec<
  TParams extends JsonRpcParams | undefined,
  TResult,
> = {
  readonly params: TParams
  readonly result: TResult
}

export type RpcSchemaShape<TSchema> = {
  readonly [TMethod in keyof TSchema]: RpcMethodSpec<JsonRpcParams | undefined, unknown>
}

export type RpcParams<TSpec> = TSpec extends RpcMethodSpec<infer TParams, unknown>
  ? TParams
  : never

export type RpcResult<TSpec> = TSpec extends RpcMethodSpec<
  JsonRpcParams | undefined,
  infer TResult
>
  ? TResult
  : never

export interface JsonRpcRequest<TParams extends JsonRpcParams | undefined> {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: TParams
}

export interface JsonRpcSuccess<TResult> {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly result: TResult
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId | null
  readonly error: JsonRpcErrorObject
}

export type JsonRpcResponse<TResult> =
  | JsonRpcFailure
  | JsonRpcSuccess<TResult>

export interface RpcSendOptions {
  readonly signal?: AbortSignal
}

export interface RpcBatchCall {
  readonly method: string
  readonly params?: JsonRpcParams
}

export interface TypedRpcBatchCall<
  TMethod extends PropertyKey = string,
  TParams extends JsonRpcParams | undefined = JsonRpcParams | undefined,
> {
  readonly method: TMethod
  readonly params?: TParams
}
