import { METHODS, type MethodName } from './methods.gen.ts'
import type { Cq1Quote, Cq1QuoteParams, RpcMethods } from './types.ts'
import { JsonRpcTransport, type BatchResult, type CallOptions, type ClientOptions, type JsonRpcCall } from '../transport.ts'
import { CarbiumSocket, type SocketOptions } from '../ws.ts'

type Spec = typeof METHODS
export type ParamsOf<M extends MethodName> = RpcMethods[M]['params']
export type ResultOf<M extends MethodName> = RpcMethods[M]['result']

type Fn<M extends MethodName> = ParamsOf<M> extends void
  ? (params?: Exclude<ParamsOf<M>, void>, options?: CallOptions) => Promise<ResultOf<M>>
  : ParamsOf<M> extends readonly unknown[]
    ? (...params: ParamsOf<M>) => Promise<ResultOf<M>>
    : (params: ParamsOf<M>, options?: CallOptions) => Promise<ResultOf<M>>

type NamesOf<P extends Spec[MethodName]['plane']> = { [M in MethodName]: Spec[M]['plane'] extends P ? M : never }[MethodName]

/** The standard Solana methods and the fee extras, each as a typed function taking the method's positional params. */
export type RpcApi = { readonly [M in NamesOf<'rpc'>]: Fn<M> }
/** The ten DAS methods, each taking one object in Helius field names. */
export type DasApi = { readonly [M in NamesOf<'das'>]: Fn<M> }
/** quote, swap, prices and health. swap returns one unsigned transaction for the user's own wallet. */
export type QuoteApi = { readonly [M in NamesOf<'quote'>]: Fn<M> }

/** A typed JSON-RPC call for a batch. */
export interface TypedCall<M extends MethodName = MethodName> {
  method: M
  params?: ParamsOf<M>
}

export interface Carbium {
  readonly rpc: RpcApi
  readonly das: DasApi
  readonly quote: QuoteApi
  readonly transport: JsonRpcTransport
  /** Any served method by name, typed by RpcMethods. */
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, options?: CallOptions): Promise<ResultOf<M>>
  /** One JSON-RPC batch, answered in order; door rules are checked locally first. */
  batch<const C extends readonly TypedCall[]>(calls: C, options?: CallOptions): Promise<{ [I in keyof C]: C[I] extends TypedCall<infer M> ? BatchResult<ResultOf<M>> : never }>
  /** A WebSocket subscription client on the same key and host. */
  socket(options?: SocketOptions): CarbiumSocket
  /** GET /cq1/quote, the REST form of the quote: one plain object back, every value a string. */
  cq1Quote(params: Cq1QuoteParams, options?: CallOptions): Promise<Cq1Quote>
}

// Compile-time proof that every generated method has a type and every typed method is generated.
const _everyMethodTyped: Exclude<MethodName, keyof RpcMethods> extends never ? true : never = true
const _everyTypeServed: Exclude<keyof RpcMethods, MethodName> extends never ? true : never = true
void _everyMethodTyped
void _everyTypeServed

function stripTrailingUndefined(params: unknown[]): unknown[] | undefined {
  let n = params.length
  while (n > 0 && params[n - 1] === undefined) n--
  return n === 0 ? undefined : params.slice(0, n)
}

/** getTransaction and getBlock answer -32015 on a v1 transaction unless maxSupportedTransactionVersion is sent: default it to 1. */
const VERSIONED: ReadonlySet<string> = new Set(['getTransaction', 'getBlock'])

function withVersion(name: string, params: unknown[]): unknown[] {
  if (!VERSIONED.has(name)) return params
  const config = typeof params[1] === 'object' && params[1] !== null ? (params[1] as Record<string, unknown>) : {}
  return [params[0], { maxSupportedTransactionVersion: 1, ...config }]
}

function plane(transport: JsonRpcTransport, which: Spec[MethodName]['plane']): Record<string, unknown> {
  const api: Record<string, unknown> = {}
  for (const [name, spec] of Object.entries(METHODS)) {
    if (spec.plane !== which) continue
    api[name] =
      spec.params === 'positional'
        ? (...params: unknown[]) => transport.call(name, stripTrailingUndefined(withVersion(name, params)))
        : (params?: unknown, options?: CallOptions) => transport.call(name, params, options)
  }
  return Object.freeze(api)
}

/** The client for services.carbium.sh: RPC, DAS, the quote plane and WebSocket subscriptions on one key. */
export function createCarbium(options: ClientOptions = {}): Carbium {
  const transport = new JsonRpcTransport(options)
  const wsBase = transport.endpoint.replace(/^http/, 'ws')
  return Object.freeze({
    rpc: plane(transport, 'rpc') as RpcApi,
    das: plane(transport, 'das') as DasApi,
    quote: plane(transport, 'quote') as QuoteApi,
    transport,
    call: <M extends MethodName>(method: M, params?: ParamsOf<M>, callOptions?: CallOptions) => transport.call(method, params, callOptions) as Promise<ResultOf<M>>,
    batch: (calls: readonly TypedCall[], callOptions?: CallOptions) => transport.batch(calls as JsonRpcCall[], callOptions) as never,
    socket: (socketOptions: SocketOptions = {}) => new CarbiumSocket({ url: wsBase, ...(options.apiKey ? { apiKey: options.apiKey } : {}), ...socketOptions }),
    cq1Quote: (params: Cq1QuoteParams, callOptions?: CallOptions) => transport.cq1Quote(params, callOptions),
  })
}
