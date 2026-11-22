/**
 * Client for the DCA API on dex.carbium.io. Each build call returns one unsigned transaction for your own wallet.
 * @module
 */
import { CarbiumError } from './errors.ts'
import { httpJson, retryAfterHeaderMs, type HttpAnswer } from './http.ts'
import type { DcaBuild, DcaClosedRecord, DcaCloseRequest, DcaHealth, DcaHistory, DcaOpenBuild, DcaOpenRequest, DcaPositionDetail, DcaPositions, DcaQuote, DcaQuoteRequest, DcaSendRequest, DcaSent, DcaUpdateRequest, DcaWithdrawRequest } from './dca-types.ts'

export interface DcaOptions {
  /** Default https://dex.carbium.io/api/dca */
  baseUrl?: string
  /** Optional: a DCA API key made in the dex account menu (DCA API access) raises the rate limits. Not a Carbium service or account key. Keyless calls are served. */
  apiKey?: string
  fetch?: typeof fetch
  /** Default 30 000. */
  timeoutMs?: number
}

const RETRYABLE = new Set(['rate_limited', 'rate_limited_open', 'rpc_unavailable', 'quote_unavailable', 'door_busy'])

function dcaError(a: HttpAnswer, method: string): CarbiumError {
  const body = typeof a.json === 'object' && a.json !== null ? (a.json as Record<string, unknown>) : {}
  const code = typeof body['err'] === 'string' ? body['err'] : null
  const detail = body['detail']
  const hint = retryAfterHeaderMs(a.headers)
  return new CarbiumError({
    kind: 'dca',
    method,
    httpStatus: a.status,
    code,
    message: typeof detail === 'string' ? detail : (code ?? (a.text.trim().slice(0, 200) || `HTTP ${a.status}`)),
    // by status, and by code too: a refusal can arrive with HTTP 200 and ok:false
    retryable: a.status === 429 || a.status === 502 || a.status === 503 || a.status === 504 || (code !== null && RETRYABLE.has(code)),
    ...(hint === undefined ? {} : { retryAfterMs: hint }),
    data: body,
  })
}

/**
 * The DCA API on the dex. Reads are keyless; the four build calls return an unsigned transaction for the owner's own
 * wallet; send relays bytes the owner signed. Server-side only: a browser page gets 403 forbidden_origin.
 */
export class CarbiumDca {
  readonly baseUrl: string
  readonly #apiKey: string | undefined
  readonly #http: { fetch?: typeof fetch; timeoutMs?: number }

  constructor(options: DcaOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://dex.carbium.io/api/dca').replace(/\/$/, '')
    this.#apiKey = options.apiKey
    this.#http = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
  }

  async #call<T>(method: string, httpMethod: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {}
    if (this.#apiKey !== undefined) headers['x-api-key'] = this.#apiKey
    const a = await httpJson(this.baseUrl + path, { method: httpMethod, headers, ...(body === undefined ? {} : { body }) }, { ...this.#http, ...(signal ? { signal } : {}) }, 'dca')
    const ok = typeof a.json === 'object' && a.json !== null && (a.json as { ok?: unknown }).ok !== false
    if (a.status >= 400 || !ok) throw dcaError(a, method)
    return a.json as T
  }

  static #query(params: Record<string, unknown>): string {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, typeof v === 'bigint' ? v.toString() : String(v))
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  /** GET /quote: a price for one buy, the fee rate and the owner's limits. */
  quote(request: DcaQuoteRequest, options: { signal?: AbortSignal } = {}): Promise<DcaQuote> {
    return this.#call('quote', 'GET', `/quote${CarbiumDca.#query({ ...request })}`, undefined, options.signal)
  }
  /** GET /positions: the owner's open positions, at most 100; pass `next` back as `after` for the rest. */
  positions(owner: string, options: { after?: string; signal?: AbortSignal } = {}): Promise<DcaPositions> {
    return this.#call('positions', 'GET', `/positions${CarbiumDca.#query({ owner, after: options.after })}`, undefined, options.signal)
  }
  /** GET /history: the owner's ended DCAs, newest close first. */
  history(owner: string, options: { after?: string; signal?: AbortSignal } = {}): Promise<DcaHistory> {
    return this.#call('history', 'GET', `/history${CarbiumDca.#query({ owner, after: options.after })}`, undefined, options.signal)
  }
  /** GET /position/{address}: one position with its fills, or its closed record. */
  position(address: string, options: { openedSlot?: number; signal?: AbortSignal } = {}): Promise<DcaPositionDetail | DcaClosedRecord> {
    return this.#call('position', 'GET', `/position/${encodeURIComponent(address)}${CarbiumDca.#query({ openedSlot: options.openedSlot })}`, undefined, options.signal)
  }
  /** GET /health: the keeper's state. Never metered. */
  health(options: { signal?: AbortSignal } = {}): Promise<DcaHealth> {
    return this.#call('health', 'GET', '/health', undefined, options.signal)
  }
  /** POST /open: builds the unsigned open transaction. */
  open(request: DcaOpenRequest, options: { signal?: AbortSignal } = {}): Promise<DcaOpenBuild> {
    return this.#call('open', 'POST', '/open', request, options.signal)
  }
  /** POST /update: builds the unsigned pause, resume or new-floor transaction. */
  update(request: DcaUpdateRequest, options: { signal?: AbortSignal } = {}): Promise<DcaBuild> {
    return this.#call('update', 'POST', '/update', request, options.signal)
  }
  /** POST /withdraw: builds the unsigned withdraw transaction. */
  withdraw(request: DcaWithdrawRequest, options: { signal?: AbortSignal } = {}): Promise<DcaBuild> {
    return this.#call('withdraw', 'POST', '/withdraw', request, options.signal)
  }
  /** POST /close: builds the unsigned close transaction. */
  close(request: DcaCloseRequest, options: { signal?: AbortSignal } = {}): Promise<DcaBuild> {
    return this.#call('close', 'POST', '/close', request, options.signal)
  }
  /** POST /send: relays a transaction this API built once the owner's wallet signed it. Never retried by the SDK. */
  send(request: DcaSendRequest, options: { signal?: AbortSignal } = {}): Promise<DcaSent> {
    const { txn_base64, built_txn_base64 } = request // only the documented fields go out
    return this.#call('send', 'POST', '/send', { txn_base64, built_txn_base64 }, options.signal)
  }
}
