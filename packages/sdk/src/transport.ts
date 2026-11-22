import { CarbiumError, isCarbiumError, type CarbiumErrorInit, type CarbiumErrorKind } from './errors.ts'
import { backoffDelayMs, decideRetry, serverHintMs, type RetryOptions, type RetryPlan } from './retry.ts'
import { METHODS } from './rpc/methods.gen.ts'
import type { Cq1Quote, Cq1QuoteParams } from './rpc/types.ts'
import { VERSION } from './version.ts'

/** Wire limits of the services.carbium.sh door, checked locally before a request is sent. */
export const LIMITS = {
  /** Largest request body in bytes; a bigger one is refused with 413. */
  bodyMaxBytes: 51200,
  /** Most calls in one JSON-RPC batch. */
  maxBatch: 100,
  /** Most permit (node slot) methods in one batch. */
  maxPermitPerBatch: 2,
  /** Most pubkeys per getMultipleAccounts on PRO; below PRO a call over 100 is refused every time. */
  maxMultipleAccounts: 300,
  /** The getMultipleAccounts size every plan admits. */
  multipleAccountsChunk: 100,
  /** Most ids per getAssets or getAssetBatch call. */
  dasMaxIds: 1000,
  /** Most mints per prices call. */
  pricesMaxMints: 64,
} as const

export const DEFAULT_ENDPOINT = 'https://services.carbium.sh'

export interface ClientOptions {
  /** The full service key, c_serv_… Omitted, the call reaches the door keyless and is refused with 401. */
  apiKey?: string
  /** Default https://services.carbium.sh. */
  endpoint?: string
  /** Default globalThis.fetch. */
  fetch?: typeof fetch
  /** The retry policy; false turns retries off. */
  retry?: RetryOptions | false
  /** Per-call timeout in ms; default 100 000, above the door's own 95 s gateway deadline so its 504 rows decide. */
  timeoutMs?: number
}

export interface CallOptions {
  signal?: AbortSignal
  retry?: RetryOptions | false
  /** The minContextSlot the call sent, so a -32016 wait can be sized. */
  minContextSlot?: number
}

export interface JsonRpcCall {
  method: string
  params?: unknown
}

export type BatchResult<T = unknown> = { ok: true; result: T } | { ok: false; error: CarbiumError }

interface RpcErrorBody {
  code?: unknown
  message?: unknown
  data?: unknown
}

interface RpcAnswer {
  id?: unknown
  result?: unknown
  error?: RpcErrorBody
}

const REQUEST_CODES: ReadonlySet<number> = new Set([-32600, -32601, -32602, -32700, -32012, -32015])
const REQUEST_REASONS: ReadonlySet<string> = new Set(['PROGRAM_NOT_PROVISIONED', 'CLASSIC_SPL_SCAN', 'METHOD_NOT_SERVED', 'UNKNOWN_METHOD'])

type MethodSpec = { batch: string; permit: boolean; plane: string }

/** The served table's entry for a method, or a refusal before anything is sent: the services do not serve it. */
function served(method: string): MethodSpec {
  if (!Object.hasOwn(METHODS, method)) throw new CarbiumError({ kind: 'request', method, code: -32601, message: `${method} is not a served method` })
  return (METHODS as unknown as Record<string, MethodSpec>)[method] as MethodSpec
}

function isRouteCode(code: number): boolean {
  return (code <= -32051 && code >= -32054) || (code <= -32060 && code >= -32099)
}

function kindOf(status: number, code: number | null, reason: string | undefined): CarbiumErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 402) return 'credits'
  if (status === 429) return 'rate_limit'
  if (status === 400 || status === 413 || status === 425 || status === 501) return 'request'
  if (status !== 200) return 'upstream'
  if (code !== null && isRouteCode(code)) return 'route'
  if ((code !== null && REQUEST_CODES.has(code)) || (reason !== undefined && REQUEST_REASONS.has(reason))) return 'request'
  return 'node'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function dataField(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined
}

/** Builds the CarbiumError for one JSON-RPC error answer, and its retry plan. Shared with the WebSocket client. */
export function rpcError(method: string, status: number, body: RpcErrorBody | undefined, headers: Headers | null, minContextSlot?: number): { error: CarbiumError; plan: RetryPlan | null } {
  const code = typeof body?.code === 'number' ? body.code : null
  const message = str(body?.message) ?? `HTTP ${status}`
  const data = body?.data
  const reason = str(dataField(data, 'reason'))
  const served = dataField(data, 'retryable')
  const ctx = { method, httpStatus: status, code, message, data, ...(minContextSlot === undefined ? {} : { minContextSlot }) }
  const plan = decideRetry(ctx)
  const init: CarbiumErrorInit = { kind: kindOf(status, code, reason), message, httpStatus: status, code, retryable: typeof served === 'boolean' ? served : plan !== null, method, data }
  if (reason !== undefined) init.reason = reason
  const hint = serverHintMs(headers, data)
  if (hint !== undefined) init.retryAfterMs = hint
  const rid = headers?.get('x-request-id')
  if (rid) init.requestId = rid
  return { error: new CarbiumError(init), plan }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A redirect is never followed: fetch would carry x-api-key and the body to whatever host it names. */
export function refuseRedirect(res: Response, method: string): void {
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new CarbiumError({ kind: 'transport', method, httpStatus: res.status, retryable: false, message: `the service answered a redirect (HTTP ${res.status}); it is not followed, so the key never goes to another host` })
  }
}

interface Answer {
  status: number
  body: unknown
  headers: Headers
}

/** The minContextSlot a positional call carries in its trailing config object, so a -32016 wait can be sized. */
function minContextSlotOf(params: unknown): number | undefined {
  if (!Array.isArray(params)) return undefined
  const last = params[params.length - 1]
  const v = typeof last === 'object' && last !== null ? (last as { minContextSlot?: unknown }).minContextSlot : undefined
  return typeof v === 'number' ? v : undefined
}

/** JSON-RPC 2.0 over HTTPS to one Carbium door, with the published retry policy. */
export class JsonRpcTransport {
  readonly endpoint: string
  readonly #apiKey: string | undefined
  readonly #fetch: typeof fetch
  readonly #retry: RetryOptions | false
  readonly #timeoutMs: number
  #nextId = 1

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey || undefined // an empty string (an unset env var) means keyless
    if (apiKey !== undefined && !/^c_serv_[A-Za-z0-9]+$/.test(apiKey)) {
      throw new CarbiumError({ kind: 'auth', message: 'apiKey must be the full service key shown once on the dashboard (it starts with c_serv_); an account key (c_acct_) is for carbium.sh/v1 only' })
    }
    const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
    if (/[?&](api[-_]?key|apiKey)=/i.test(endpoint) || /^https?:\/\/[^/]+\/c_serv_/.test(endpoint)) {
      throw new CarbiumError({ kind: 'request', message: 'put the key in apiKey, not in the endpoint URL: a key in a URL ends up in logs and referers' })
    }
    this.endpoint = endpoint
    this.#apiKey = apiKey
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#retry = options.retry ?? {}
    this.#timeoutMs = options.timeoutMs ?? 100_000
  }

  /** One call. Resolves with the result or throws a CarbiumError; a method the services do not serve is refused before sending. */
  async call(method: string, params?: unknown, options: CallOptions = {}): Promise<unknown> {
    served(method)
    const id = this.#nextId++
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params !== undefined) body['params'] = params
    const mcs = options.minContextSlot ?? minContextSlotOf(params)
    if (mcs !== undefined && options.minContextSlot === undefined) options = { ...options, minContextSlot: mcs }
    const a = await this.#send(JSON.stringify(body), method, options, false)
    if (Array.isArray(a.body) || typeof a.body !== 'object' || a.body === null) throw new CarbiumError({ kind: 'upstream', method, httpStatus: a.status, message: 'malformed JSON-RPC answer' })
    const one = a.body as RpcAnswer
    if (one.error) throw rpcError(method, a.status, one.error, a.headers, options.minContextSlot).error
    if (!('result' in one)) throw new CarbiumError({ kind: 'upstream', method, httpStatus: a.status, message: 'malformed JSON-RPC answer: neither result nor error' })
    return one.result
  }

  /**
   * One JSON-RPC batch, 1 to 100 calls, answered in order. Refused locally before sending when it breaks a door rule:
   * a method that never batches, DAS mixed with other planes, more than two permit methods, or a body over the cap.
   * A door refusal of the whole batch throws; a per-call error comes back as { ok: false, error }.
   */
  async batch(calls: ReadonlyArray<JsonRpcCall>, options: CallOptions = {}): Promise<BatchResult[]> {
    if (calls.length === 0 || calls.length > LIMITS.maxBatch) {
      throw new CarbiumError({ kind: 'request', message: `a batch holds 1 to ${LIMITS.maxBatch} calls, not ${calls.length}` })
    }
    let permits = 0
    let das = 0
    for (const c of calls) {
      const spec = served(c.method)
      if (spec.batch === 'never') throw new CarbiumError({ kind: 'request', method: c.method, message: `${c.method} is not batchable: send it alone` })
      if (spec.permit) permits++
      if (spec.plane === 'das') das++
    }
    if (das !== 0 && das !== calls.length) throw new CarbiumError({ kind: 'request', message: 'DAS methods batch only with other DAS methods' })
    if (permits > LIMITS.maxPermitPerBatch) throw new CarbiumError({ kind: 'request', message: `a batch holds at most ${LIMITS.maxPermitPerBatch} permit methods (getAccountInfo, getMultipleAccounts, getTransaction, ...), not ${permits}: split it` })
    const firstId = this.#nextId
    this.#nextId += calls.length
    const body = JSON.stringify(calls.map((c, i) => (c.params === undefined ? { jsonrpc: '2.0', id: firstId + i, method: c.method } : { jsonrpc: '2.0', id: firstId + i, method: c.method, params: c.params })))
    const label = calls.some((c) => c.method === 'sendTransaction') ? 'sendTransaction' : `batch(${calls[0]?.method})`
    const a = await this.#send(body, label, options, true)
    if (!Array.isArray(a.body)) {
      const err = (a.body as RpcAnswer | null)?.error
      throw err ? rpcError(label, a.status, err, a.headers).error : new CarbiumError({ kind: 'upstream', httpStatus: a.status, message: 'the door answered a batch with a single object' })
    }
    const answers = a.body as RpcAnswer[]
    const first = answers[0]?.error
    if (first && answers.length > 0 && answers.every((el) => el?.error && el.error.code === first.code && dataField(el.error.data, 'reason') !== undefined && dataField(el.error.data, 'reason') === dataField(first.data, 'reason'))) {
      throw rpcError(label, a.status, first, a.headers).error // the door refused the whole batch: every element carries the same refusal
    }
    const byId = new Map<number, RpcAnswer>()
    for (const el of answers) if (typeof el?.id === 'number') byId.set(el.id, el)
    return calls.map((c, i) => {
      const el = byId.get(firstId + i)
      if (!el) return { ok: false, error: new CarbiumError({ kind: 'upstream', method: c.method, httpStatus: a.status, message: 'no answer for this batch element' }) }
      if (el.error) return { ok: false, error: rpcError(c.method, a.status, el.error, a.headers).error }
      return { ok: true, result: el.result }
    })
  }

  /**
   * GET /cq1/quote, the REST form of the quote: the same scope, plan, rate and 0 credits as the JSON-RPC quote, one
   * plain JSON object back with every value a string. The key goes in x-api-key, never in the query.
   */
  async cq1Quote(params: Cq1QuoteParams, options: CallOptions = {}): Promise<Cq1Quote> {
    const query = new URLSearchParams({ src_mint: params.src_mint, dst_mint: params.dst_mint, amount_in: String(params.amount_in), slippage_bps: String(params.slippage_bps) })
    let a: Answer
    try {
      a = await this.#send('', 'cq1Quote', options, false, `${this.endpoint.replace(/\/$/, '')}/cq1/quote?${query}`)
    } catch (e) {
      // 422 in plain text is a pair or size with no route ("No valid routes found"): a route error, never retried
      if (isCarbiumError(e) && e.httpStatus === 422) throw new CarbiumError({ kind: 'route', method: 'cq1Quote', httpStatus: 422, code: e.code, retryable: false, message: e.message.replace(/ \(x-request-id: [^)]*\)$/, ''), ...(e.requestId ? { requestId: e.requestId } : {}) })
      throw e
    }
    if (typeof a.body !== 'object' || a.body === null || Array.isArray(a.body)) throw new CarbiumError({ kind: 'upstream', method: 'cq1Quote', httpStatus: a.status, message: 'malformed /cq1/quote answer: not one JSON object' })
    return a.body as Cq1Quote
  }

  async #send(body: string, method: string, options: CallOptions, isBatch: boolean, getUrl?: string): Promise<Answer> {
    const bytes = new TextEncoder().encode(body).byteLength
    if (bytes > LIMITS.bodyMaxBytes) throw new CarbiumError({ kind: 'request', method, message: `request body is ${bytes} bytes; the cap is ${LIMITS.bodyMaxBytes}: split the batch or narrow the call` })
    const retry = options.retry ?? this.#retry
    const userMax = retry === false ? 1 : retry.maxAttempts
    const maxHintMs = retry === false ? 0 : (retry.maxHintMs ?? 30_000)
    const random = retry === false ? Math.random : (retry.random ?? Math.random)
    const headers: Record<string, string> = getUrl === undefined ? { 'content-type': 'application/json', 'solana-client': `js/@carbium/sdk@${VERSION}` } : { 'solana-client': `js/@carbium/sdk@${VERSION}` }
    if (this.#apiKey !== undefined) headers['x-api-key'] = this.#apiKey
    const stop = (plan: RetryPlan | null, attempt: number): boolean => plan === null || attempt >= (userMax === undefined ? plan.maxAttempts : Math.min(userMax, plan.maxAttempts))
    for (let attempt = 1; ; attempt++) {
      let res: Response
      let text: string
      const signals: AbortSignal[] = [AbortSignal.timeout(this.#timeoutMs)]
      if (options.signal) signals.push(options.signal)
      try {
        res = await this.#fetch(getUrl ?? this.endpoint, getUrl === undefined ? { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.any(signals) } : { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.any(signals) })
        refuseRedirect(res, method)
        text = await res.text()
      } catch (cause) {
        if (options.signal?.aborted) throw cause
        if (isCarbiumError(cause)) throw cause // a refused redirect: final
        const timedOut = cause instanceof Error && cause.name === 'TimeoutError'
        const decided = decideRetry({ method, httpStatus: 0, code: null, message: '', data: undefined })
        const plan = decided && timedOut ? { ...decided, maxAttempts: 2 } : decided // a read that outran the client timeout is tried once more, as the 504 row says
        if (stop(plan, attempt)) throw new CarbiumError({ kind: 'transport', method, message: cause instanceof Error ? cause.message : 'request failed', retryable: plan !== null, cause })
        await sleep(backoffDelayMs(plan as RetryPlan, attempt, undefined, random), options.signal)
        continue
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const answer: Answer = { status: res.status, body: parsed, headers: res.headers }
      if (res.status === 200 && typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray(parsed) || isBatch) return answer // per-element errors are the caller's
        const err = (parsed as RpcAnswer).error
        if (!err) return answer
        // a method-level error at 200: retried only on the rows the policy names
        const r = rpcError(method, 200, err, res.headers, options.minContextSlot)
        if (stop(r.plan, attempt)) return answer
        if (r.error.retryAfterMs !== undefined && r.error.retryAfterMs > maxHintMs) return answer // not waited for, as on the other paths
        await sleep(backoffDelayMs(r.plan as RetryPlan, attempt, r.error.retryAfterMs, random), options.signal)
        continue
      }
      const errBody = Array.isArray(parsed) ? (parsed[0] as RpcAnswer | undefined)?.error : typeof parsed === 'object' && parsed !== null ? (parsed as RpcAnswer).error : undefined
      if (res.status === 200 && !errBody) {
        const rid = res.headers.get('x-request-id')
        throw new CarbiumError({ kind: 'upstream', method, httpStatus: 200, message: `malformed JSON-RPC answer: ${text.trim().slice(0, 120) || 'empty body'}`, ...(rid ? { requestId: rid } : {}) })
      }
      const r = rpcError(method, res.status, errBody ?? { message: text.trim().slice(0, 200) || `HTTP ${res.status}` }, res.headers)
      if (stop(r.plan, attempt)) throw r.error
      if (r.error.retryAfterMs !== undefined && r.error.retryAfterMs > maxHintMs) throw r.error
      await sleep(backoffDelayMs(r.plan as RetryPlan, attempt, r.error.retryAfterMs, random), options.signal)
    }
  }
}
