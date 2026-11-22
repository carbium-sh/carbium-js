/**
 * The one retry and backoff policy carbium.sh/skill.md states for every plane: wait the larger of the server's hint
 * (retry-after-ms, else Retry-After in seconds) and 250 ms × 2^(attempt−1) capped at 4 s, plus 0 to 250 ms of jitter;
 * never cut a server hint; stop after 4 attempts unless the row says otherwise. sendTransaction is never retried.
 */
export interface RetryOptions {
  /** A cap on the total calls including the first. Unset, each policy row's own count applies (4 for most, about 6 for a scan index behind). */
  maxAttempts?: number
  /** A server hint above this is not waited for: the error is thrown at once with retryAfterMs set. Default 30 000. */
  maxHintMs?: number
  /** Random source for the jitter, 0 ≤ r < 1. Default Math.random. */
  random?: () => number
}

export interface RetryPlan {
  baseMs: number
  capMs: number
  maxAttempts: number
}

export interface RetryContext {
  method: string
  /** HTTP status, 0 for no answer. */
  httpStatus: number
  /** JSON-RPC error code, null when the body had none. */
  code: number | null
  message: string
  /** error.data as served. */
  data: unknown
  /** True when the call was a batch holding more than two permit methods (a permanent 429). */
  overPermitCap?: boolean
  /** The caller's minContextSlot, for -32016. */
  minContextSlot?: number
}

const STD: RetryPlan = { baseMs: 250, capMs: 4000, maxAttempts: 4 }

function field(data: unknown, key: string): unknown {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[key] : undefined
}

/** Decides whether a failed call is retried and with which backoff; null means do not retry. */
export function decideRetry(ctx: RetryContext): RetryPlan | null {
  const { httpStatus: status, code, message: msg } = ctx
  if (ctx.method === 'sendTransaction') return null // a send may have landed: check the signature, never resend blindly
  if (status === 0) return STD // no answer: network error or timeout
  if (field(ctx.data, 'retryable') === false) return null // the door says waiting cannot help
  if (ctx.overPermitCap) return null // the door never admits a batch with more than two permit methods
  switch (status) {
    case 429:
      return code === -32010 ? { baseMs: 100, capMs: 5000, maxAttempts: 6 } : STD // scan index behind: 100, 200, 400 ... 5 s, about 6 tries
    case 425:
      return { baseMs: 0, capMs: 0, maxAttempts: 2 } // early data refused, nothing was forwarded
    case 502:
      return /response too large/.test(msg) ? null : STD
    case 503:
      if (/^upstream RPC unavailable/.test(msg)) return { baseMs: 2000, capMs: 8000, maxAttempts: 4 }
      if (msg === 'compat verbs not initialised') return { ...STD, maxAttempts: 3 }
      return STD
    case 504:
      return msg.startsWith('upstream_slow') ? null : { ...STD, maxAttempts: 2 } // a scan over its deadline: once
    case 200:
      if (field(ctx.data, 'reason') !== undefined) return null // a door policy answer at 200 is final
      switch (code) {
        case -32602:
          return msg.startsWith('the walk read no history') ? STD : null
        case -32016: {
          const ctxSlot = field(ctx.data, 'contextSlot')
          const missing = typeof ctxSlot === 'number' && ctx.minContextSlot ? ctx.minContextSlot - ctxSlot : 1
          const wait = Math.min(30_000, Math.max(250, 220 * Math.max(missing, 1))) // about 220 ms per missing slot
          return { baseMs: wait, capMs: wait, maxAttempts: 4 }
        }
        case -32004:
          return { baseMs: 1000, capMs: 2000, maxAttempts: 4 } // block not available yet
        case -32014:
          return { baseMs: 1000, capMs: 1000, maxAttempts: 4 } // block status not yet available
        case -32005:
        case -32021:
        case -32024:
        case -32026:
          return STD
        case -32011:
          return msg === 'das upstream timed out' ? STD : null
        case -32603:
          return /^(Internal error|das upstream refused the request|upstream internal error)$/.test(msg) ? { ...STD, maxAttempts: 2 } : null
        case -32010:
          return /peer refused the copy/.test(msg) ? { baseMs: 20000, capMs: 20000, maxAttempts: 2 } : null
        default:
          return null
      }
    default:
      return null // 400, 401, 402, 403, 413, 501 and anything unknown
  }
}

/** The server's wait hint in ms: retry-after-ms, else data.retryAfterMs, else Retry-After (seconds or an HTTP date). */
export function serverHintMs(headers: Headers | null | undefined, data: unknown): number | undefined {
  const ms = headers?.get('retry-after-ms')
  if (ms && /^\d+$/.test(ms)) return Number(ms)
  const inData = field(data, 'retryAfterMs')
  if (typeof inData === 'number' && inData >= 0) return inData
  const ra = headers?.get('retry-after')
  if (!ra) return undefined
  if (/^\d+$/.test(ra)) return Number(ra) * 1000
  const at = Date.parse(ra)
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

/** The wait before retry number `attempt` (1 for the first retry): max(hint, backoff) plus jitter. */
export function backoffDelayMs(plan: RetryPlan, attempt: number, hintMs: number | undefined, random: () => number = Math.random): number {
  const computed = Math.min(plan.capMs, plan.baseMs * 2 ** (attempt - 1))
  return Math.max(hintMs ?? 0, computed) + Math.floor(random() * 251)
}
