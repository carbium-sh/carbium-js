/**
 * Client for the token metadata API on tokens.carbium.io.
 * @module
 */
import { CarbiumError } from './errors.ts'
import { httpJson, retryAfterHeaderMs, type HttpAnswer } from './http.ts'
import type { Token, TokenBatch, TokenSearch, TokenSearchOptions } from './tokens-types.ts'

export interface TokensOptions {
  /** Default https://tokens.carbium.io */
  baseUrl?: string
  fetch?: typeof fetch
  /** Default 30 000. */
  timeoutMs?: number
}

export const TOKENS_LIMITS = {
  /** Most mints per batch call. */
  batchMaxMints: 500,
} as const

function tokensError(a: HttpAnswer, method: string): CarbiumError {
  const body = typeof a.json === 'object' && a.json !== null ? (a.json as Record<string, unknown>) : {}
  const code = typeof body['error'] === 'string' ? body['error'] : null
  const hint = retryAfterHeaderMs(a.headers) ?? (typeof body['retryAfterSec'] === 'number' ? body['retryAfterSec'] * 1000 : undefined)
  return new CarbiumError({
    kind: 'tokens',
    method,
    httpStatus: a.status,
    code,
    message: typeof body['message'] === 'string' ? body['message'] : (code ?? (a.text.trim().slice(0, 200) || `HTTP ${a.status}`)),
    retryable: a.status === 429 || a.status === 503,
    ...(hint === undefined ? {} : { retryAfterMs: hint }),
    data: body,
  })
}

/** The token metadata API at tokens.carbium.io. Keyless; fine in browsers. 300 requests a minute per client. */
export class CarbiumTokens {
  readonly baseUrl: string
  readonly #http: { fetch?: typeof fetch; timeoutMs?: number }

  constructor(options: TokensOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://tokens.carbium.io').replace(/\/$/, '')
    this.#http = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
  }

  async #get(path: string, method: string, signal?: AbortSignal): Promise<HttpAnswer> {
    const a = await httpJson(this.baseUrl + path, { method: 'GET' }, { ...this.#http, ...(signal ? { signal } : {}) }, 'tokens')
    if (a.status >= 400) throw tokensError(a, method)
    return a
  }

  async #post(path: string, body: unknown, method: string, signal?: AbortSignal): Promise<HttpAnswer> {
    const a = await httpJson(this.baseUrl + path, { method: 'POST', body }, { ...this.#http, ...(signal ? { signal } : {}) }, 'tokens')
    if (a.status >= 400) throw tokensError(a, method)
    return a
  }

  /** GET /tokens/:mint. Resolves null when the registry does not hold the mint (404 not_found). */
  async lookup(mint: string, options: { signal?: AbortSignal } = {}): Promise<Token | null> {
    const a = await httpJson(`${this.baseUrl}/tokens/${encodeURIComponent(mint)}`, { method: 'GET' }, { ...this.#http, ...options }, 'tokens')
    if (a.status === 404) return null
    if (a.status >= 400) throw tokensError(a, 'lookup')
    return a.json as Token
  }

  /** GET /tokens?q=: a ranked search, or the top listing by volume when q is empty. */
  async search(q: string, options: TokenSearchOptions & { signal?: AbortSignal } = {}): Promise<TokenSearch> {
    const p = new URLSearchParams({ q })
    if (options.limit !== undefined) p.set('limit', String(options.limit))
    if (options.page !== undefined) p.set('page', String(options.page))
    if (options.includeToken22 !== undefined) p.set('include_token22', String(options.includeToken22))
    return (await this.#get(`/tokens?${p}`, 'search', options.signal)).json as TokenSearch
  }

  /** POST /tokens/batch, up to 500 mints. Unknown mints come back in `unknown` and are queued for enrichment. */
  async batch(mints: readonly string[], options: { signal?: AbortSignal } = {}): Promise<TokenBatch> {
    if (mints.length === 0 || mints.length > TOKENS_LIMITS.batchMaxMints) throw new CarbiumError({ kind: 'tokens', method: 'batch', message: `batch takes 1 to ${TOKENS_LIMITS.batchMaxMints} mints, not ${mints.length}` })
    return (await this.#post('/tokens/batch', { mints }, 'batch', options.signal)).json as TokenBatch
  }

  /** The URL of GET /img/:mint, for an <img src>. Always answers 200, with an SVG fallback when no logo is known. */
  imageUrl(mint: string): string {
    return `${this.baseUrl}/img/${encodeURIComponent(mint)}`
  }
}
