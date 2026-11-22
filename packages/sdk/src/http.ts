import { CarbiumError, isCarbiumError } from './errors.ts'

export interface HttpAnswer {
  status: number
  headers: Headers
  text: string
  /** The parsed JSON body, or undefined when the body is not JSON. */
  json: unknown
}

export interface HttpOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

/** Milliseconds from a Retry-After header: whole seconds or an HTTP date. */
export function retryAfterHeaderMs(headers: Headers): number | undefined {
  const ra = headers.get('retry-after')
  if (!ra) return undefined
  if (/^\d+$/.test(ra)) return Number(ra) * 1000
  const at = Date.parse(ra)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** One JSON HTTP exchange with a timeout; bigint values in the body are sent as decimal strings. */
export async function httpJson(url: string, init: { method: string; headers?: Record<string, string>; body?: unknown }, options: HttpOptions, kind: 'account' | 'dca' | 'tokens'): Promise<HttpAnswer> {
  const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs ?? 30_000)]
  if (options.signal) signals.push(options.signal)
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
  let body: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))
  }
  let res: Response
  let text: string
  try {
    res = await (options.fetch ?? globalThis.fetch)(url, { method: init.method, headers, ...(body === undefined ? {} : { body }), redirect: 'manual', signal: AbortSignal.any(signals) })
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new CarbiumError({ kind: 'transport', httpStatus: res.status, retryable: false, message: `the service answered a redirect (HTTP ${res.status}); it is not followed, so the key never goes to another host` })
    }
    text = await res.text()
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    if (isCarbiumError(cause)) throw cause
    throw new CarbiumError({ kind, message: cause instanceof Error ? cause.message : 'request failed', retryable: init.method === 'GET', cause })
  }
  let json: unknown
  try {
    json = text === '' ? undefined : JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: res.headers, text, json }
}
