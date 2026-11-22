/**
 * One error class for the whole SDK. Check it with isCarbiumError(), not instanceof: a dual ESM and CJS install can
 * load two copies of the class. `kind` is the coarse category, `code` and `reason` carry the service's own detail.
 */
export type CarbiumErrorKind =
  /** 401/403: the key is unknown, suspended, revoked, lacks the plane or module, or the address is not allowed. */
  | 'auth'
  /** 402: credits exhausted. Waiting never helps. */
  | 'credits'
  /** 429: a rate, slot or load refusal, or credits still loading. Waiting helps. */
  | 'rate_limit'
  /** The request itself must change: bad params, unknown method, body or batch over a cap, unsupported shape. */
  | 'request'
  /** 5xx or an upstream answer that waiting may fix. */
  | 'upstream'
  /** HTTP 200 with an error from the node, the index or the DAS store (agave codes, -32021..-32026, ...). */
  | 'node'
  /** Quote and swap plane: no route, unknown venue, reserves, pool state, expired quote (-32051..-32054, -32060..-32099). */
  | 'route'
  /** No HTTP answer at all: network error, timeout or abort. */
  | 'transport'
  /** A WebSocket handshake refusal, in-socket refusal or terminal close. */
  | 'socket'
  /** A Carbon Stream (gRPC) refusal that ends the stream. */
  | 'stream'
  /** The account API on carbium.sh answered with an error. */
  | 'account'
  /** The DCA API answered ok:false. */
  | 'dca'
  /** The token API answered with an error. */
  | 'tokens'
  /** A webhook delivery failed its signature check. */
  | 'webhook'

export interface CarbiumErrorInit {
  kind: CarbiumErrorKind
  message: string
  /** HTTP status of the answer; 0 when there was none. */
  httpStatus?: number
  /** JSON-RPC error code, an HTTP API's error string, a gRPC status, or a close code. */
  code?: number | string | null
  /** The door's error.data.reason (UPPER_SNAKE), a close reason, or a gRPC status name. */
  reason?: string
  /** Whether waiting and sending the same request again can change the answer. */
  retryable?: boolean
  /** The server's wait hint in milliseconds, when it gave one. */
  retryAfterMs?: number
  /** x-request-id of the answer, to quote to support. */
  requestId?: string
  /** The method, subscription, route or filter the error belongs to. */
  method?: string
  /** The error's data object as served, redacted. */
  data?: unknown
  cause?: unknown
}

// Five or more characters after the label: the 4-character prefix the dashboard shows (c_serv_AbCd) names a key, it is not one.
const SECRET = /\b(c_serv_|c_acct_|whsec_)[A-Za-z0-9+/=_-]{5,}/g
const KEY_IN_URL = /((?:api[-_]?key|apiKey|token)=)[^&\s"'<>]+/gi
const KEY_IN_SUBPROTOCOL = /(api-key\.)[A-Za-z0-9_-]+/g

/** Replaces service keys, account keys, webhook secrets and key-bearing URL parts with a placeholder. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET, '$1…').replace(KEY_IN_URL, '$1…').replace(KEY_IN_SUBPROTOCOL, '$1…')
}

function redactDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (value instanceof Error) {
    const e = new Error(redactSecrets(value.message), value.cause === undefined ? undefined : { cause: redactDeep(value.cause, depth + 1) })
    e.name = value.name
    const code = (value as { code?: unknown }).code
    if (code !== undefined) (e as { code?: unknown }).code = redactDeep(code, depth + 1)
    return e
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1)
  return out
}

export class CarbiumError extends Error {
  override readonly name: 'CarbiumError' = 'CarbiumError'
  readonly kind: CarbiumErrorKind
  readonly httpStatus: number
  readonly code: number | string | null
  readonly reason: string | undefined
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined
  readonly requestId: string | undefined
  readonly method: string | undefined
  readonly data: unknown

  constructor(init: CarbiumErrorInit) {
    const tail = init.requestId ? ` (x-request-id: ${init.requestId})` : ''
    super(redactSecrets(init.message) + tail, init.cause === undefined ? undefined : { cause: redactDeep(init.cause) })
    this.kind = init.kind
    this.httpStatus = init.httpStatus ?? 0
    this.code = init.code ?? null
    this.reason = init.reason
    this.retryable = init.retryable ?? false
    this.retryAfterMs = init.retryAfterMs
    this.requestId = init.requestId
    this.method = init.method
    this.data = redactDeep(init.data)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      httpStatus: this.httpStatus,
      code: this.code,
      reason: this.reason,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      requestId: this.requestId,
      method: this.method,
      data: this.data,
    }
  }
}

/** True for a CarbiumError from any copy of this package. */
export function isCarbiumError(value: unknown): value is CarbiumError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'CarbiumError' &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}
