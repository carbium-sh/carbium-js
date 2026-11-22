import { CarbiumError } from './errors.ts'
import { SUBSCRIPTIONS, type SubscriptionName } from './rpc/methods.gen.ts'
import type { AccountInfo, Base58, Block, Commitment, DataSlice, Encoding, KeyedAccount, MemcmpEncoding, TransactionError, WithContext } from './rpc/types.ts'
import { rpcError } from './transport.ts'

/** The part of a WebSocket the client uses: the global WebSocket (browsers, Node 22+) or the `ws` package. */
export interface WebSocketLike {
  readonly readyState: number
  readonly protocol?: string
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  /** `ws` only: 'unexpected-response' (a refused handshake with its status) and 'ping'. */
  on?(event: string, listener: (...args: never[]) => void): unknown
  /** `ws` only. */
  terminate?(): void
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WebSocketConstructor = new (url: string, protocols?: string | string[], ...rest: any[]) => WebSocketLike

export type SocketState = 'idle' | 'connecting' | 'open' | 'backoff' | 'closed'
export interface CloseInfo {
  code: number
  reason: string
}

export interface SocketOptions {
  /** The full service key with the ws scope. */
  apiKey?: string
  /** Default wss://services.carbium.sh */
  url?: string
  /** Default globalThis.WebSocket. Pass the `ws` package's class in Node to use the x-api-key header carrier. */
  WebSocket?: WebSocketConstructor
  /**
   * How the key travels in the handshake. 'subprotocol' (default) offers Sec-WebSocket-Protocol "carbium, api-key.<key>"
   * and works everywhere; 'header' sends x-api-key and needs the `ws` package. The key never goes in the URL.
   */
  carrier?: 'subprotocol' | 'header'
  /** Called after every reconnect, once every live subscription is bound again; gap is true after close 1012 stream_gap_reseed_required. Re-read state you may have missed. */
  onReseed?: (info: CloseInfo & { gap: boolean }) => void
  /** Called once when the socket gives up: a key refusal, a second credits_exhausted, or three refused handshakes. */
  onFatal?: (error: CarbiumError) => void
  /** A subscription the server refused when it was bound again after a reconnect. */
  onError?: (error: CarbiumError) => void
  onState?: (state: SocketState, info?: CloseInfo) => void
  random?: () => number
}

/** logsSubscribe: every transaction, every one with votes too, or those that mention one address. */
export type LogsFilter = 'all' | 'allWithVotes' | { mentions: [Base58] }
/** blockSubscribe: every block, or blocks with a transaction that mentions an account or program. */
export type BlockFilter = 'all' | { mentionsAccountOrProgram: Base58 }
/** blockSubscribe takes confirmed or finalized only. */
export type SettledCommitment = 'confirmed' | 'finalized'
export type BlockEncoding = 'json' | 'base64' | 'base58'
export type BlockSubscribeDetails = 'full' | 'signatures' | 'none'
/** A programSubscribe filter: exactly one of dataSize or memcmp; at most four per subscription. */
export type ProgramSubscribeFilter = { dataSize: number } | { memcmp: { offset: number; bytes: string; encoding?: MemcmpEncoding } }

/** The eight served subscriptions: their params and the notification result they deliver. */
export interface SubscriptionMethods {
  accountSubscribe: { params: [pubkey: Base58, config?: { commitment?: Commitment; encoding?: Encoding | 'binary'; dataSlice?: DataSlice }]; result: WithContext<AccountInfo> }
  programSubscribe: { params: [programId: Base58, config?: { commitment?: Commitment; encoding?: Encoding; dataSlice?: DataSlice; filters?: ProgramSubscribeFilter[] }]; result: WithContext<KeyedAccount> }
  logsSubscribe: { params: [filter: LogsFilter, config?: { commitment?: Commitment }]; result: WithContext<{ signature: Base58; err: TransactionError | null; logs: string[] }> }
  /** Fires once, then the server ends the subscription. After a reconnect, check getSignatureStatuses. */
  signatureSubscribe: { params: [signature: Base58, config?: { commitment?: Commitment }]; result: WithContext<{ err: TransactionError | null }> }
  slotSubscribe: { params: []; result: { slot: number; parent: number; root: number } }
  rootSubscribe: { params: []; result: number }
  slotsUpdatesSubscribe: { params: []; result: { type: string; slot: number; timestamp: number; parent?: number; stats?: Record<string, number>; err?: string } }
  blockSubscribe: {
    params: [filter: BlockFilter, config?: { commitment?: SettledCommitment; encoding?: BlockEncoding; transactionDetails?: BlockSubscribeDetails; showRewards?: boolean; maxSupportedTransactionVersion?: number }]
    result: WithContext<{ slot: number; err: TransactionError | null; block: Block | null }>
  }
}
const _everySubscriptionTyped: Exclude<SubscriptionName, keyof SubscriptionMethods> extends never ? true : never = true
const _everyTypeServed: Exclude<keyof SubscriptionMethods, SubscriptionName> extends never ? true : never = true
void _everySubscriptionTyped
void _everyTypeServed

export type SubscriptionParams<M extends SubscriptionName> = SubscriptionMethods[M]['params']
export type Notification<M extends SubscriptionName> = SubscriptionMethods[M]['result']

export interface Subscription {
  /** Resolves with the server's subscription id once acknowledged; rejects when the server refuses it. */
  readonly ready: Promise<number>
  unsubscribe(): Promise<void>
}

interface Handle {
  method: SubscriptionName
  params: unknown[]
  onNotification: (result: never) => void
  serverId: number | undefined
  acked: boolean
  resolve: (id: number) => void
  reject: (error: CarbiumError) => void
}

interface Pending {
  method: string
  /** A bind names its handle so #onMessage records the server id before the next frame: a notification can follow its ack at once. */
  bind?: Handle | undefined
  resolve: (result: unknown) => void
  reject: (error: CarbiumError) => void
}

const RETRY_REASONS: ReadonlySet<string> = new Set(['RATE_LIMITED', 'LOAD_SHED', 'FREE_SUBNET_LIMITED', 'FREE_TIER_BUSY', 'CREDITS_PENDING'])
const BIND_BATCH = 32
const PING_WATCHDOG_MS = 75_000

/**
 * JSON-RPC subscriptions over wss://services.carbium.sh with the published reconnect rules: every live subscription
 * is bound again after a reconnect, server ids are remapped, and onReseed tells you to re-read state. Nothing is
 * replayed by the server after a disconnect.
 */
export class CarbiumSocket {
  readonly url: string
  readonly #apiKey: string | undefined
  readonly #ctor: WebSocketConstructor | undefined
  readonly #carrier: 'subprotocol' | 'header'
  readonly #opts: SocketOptions
  readonly #random: () => number
  #ws: WebSocketLike | undefined
  #state: SocketState = 'idle'
  #handles = new Map<number, Handle>()
  #byServerId = new Map<number, Handle>()
  #pending = new Map<number, Pending>()
  #nextId = 1
  #nextLocal = 1
  #attempt = 0
  #preOpenFailures = 0
  #overloadCloses = 0
  #handshakeStatus: number | undefined
  #creditsExhaustedOnce = false
  #everOpened = false
  #openedThisConnection = false
  #closedByUser = false
  #fatal: CarbiumError | undefined
  #handshakeRetryAfterMs: number | undefined
  #watchdog: ReturnType<typeof setTimeout> | undefined
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: SocketOptions = {}) {
    const apiKey = options.apiKey || undefined
    if (apiKey !== undefined && !/^c_serv_[A-Za-z0-9]+$/.test(apiKey)) {
      throw new CarbiumError({ kind: 'auth', message: 'apiKey must be the full service key (c_serv_…) with the websocket scope' })
    }
    this.url = (options.url ?? 'wss://services.carbium.sh').replace(/^http/, 'ws').replace(/\/$/, '')
    if (/[?&](api[-_]?key|apiKey)=/i.test(this.url)) throw new CarbiumError({ kind: 'request', message: 'put the key in apiKey, not in the url' })
    this.#apiKey = apiKey
    this.#ctor = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    this.#carrier = options.carrier ?? 'subprotocol'
    this.#opts = options
    this.#random = options.random ?? Math.random
  }

  get state(): SocketState {
    return this.#state
  }

  /** How many subscriptions this socket holds. */
  get size(): number {
    return this.#handles.size
  }

  /** Any served subscription by name; the typed methods below call this. */
  subscribe<M extends SubscriptionName>(method: M, params: SubscriptionParams<M>, onNotification: (result: Notification<M>) => void): Subscription {
    if (!(SUBSCRIPTIONS as readonly string[]).includes(method)) throw new CarbiumError({ kind: 'request', method, message: `${method} is not a served subscription` })
    if (this.#fatal) throw this.#fatal
    if (this.#closedByUser) throw new CarbiumError({ kind: 'socket', method, message: 'the socket was closed' })
    const localId = this.#nextLocal++
    let resolve!: (id: number) => void
    let reject!: (error: CarbiumError) => void
    const ready = new Promise<number>((res, rej) => {
      resolve = res
      reject = rej
    })
    ready.catch(() => undefined)
    const handle: Handle = { method, params: params as unknown[], onNotification: onNotification as (result: never) => void, serverId: undefined, acked: false, resolve, reject }
    this.#handles.set(localId, handle)
    if (this.#state === 'open') void this.#bind(handle)
    else if (this.#state === 'idle' || this.#state === 'closed') this.#connect()
    return {
      ready,
      unsubscribe: async () => {
        const h = this.#handles.get(localId)
        if (!h) return
        this.#handles.delete(localId)
        if (h.serverId !== undefined) {
          this.#byServerId.delete(h.serverId)
          if (this.#state === 'open') await this.#request(method.replace(/Subscribe$/, 'Unsubscribe'), [h.serverId]).catch(() => undefined) // false or -32602 both mean gone
        }
        if (!h.acked) h.reject(new CarbiumError({ kind: 'socket', method, message: 'unsubscribed before the acknowledgement' }))
        if (this.#handles.size === 0 && this.#state === 'open') this.#ws?.close(1000, 'no subscriptions')
      },
    }
  }

  accountSubscribe(pubkey: Base58, onNotification: (n: Notification<'accountSubscribe'>) => void, config?: SubscriptionParams<'accountSubscribe'>[1]): Subscription {
    return this.subscribe('accountSubscribe', config ? [pubkey, config] : [pubkey], onNotification)
  }
  programSubscribe(programId: Base58, onNotification: (n: Notification<'programSubscribe'>) => void, config?: SubscriptionParams<'programSubscribe'>[1]): Subscription {
    return this.subscribe('programSubscribe', config ? [programId, config] : [programId], onNotification)
  }
  logsSubscribe(filter: SubscriptionParams<'logsSubscribe'>[0], onNotification: (n: Notification<'logsSubscribe'>) => void, config?: SubscriptionParams<'logsSubscribe'>[1]): Subscription {
    return this.subscribe('logsSubscribe', config ? [filter, config] : [filter], onNotification)
  }
  signatureSubscribe(signature: Base58, onNotification: (n: Notification<'signatureSubscribe'>) => void, config?: SubscriptionParams<'signatureSubscribe'>[1]): Subscription {
    return this.subscribe('signatureSubscribe', config ? [signature, config] : [signature], onNotification)
  }
  slotSubscribe(onNotification: (n: Notification<'slotSubscribe'>) => void): Subscription {
    return this.subscribe('slotSubscribe', [], onNotification)
  }
  rootSubscribe(onNotification: (n: Notification<'rootSubscribe'>) => void): Subscription {
    return this.subscribe('rootSubscribe', [], onNotification)
  }
  slotsUpdatesSubscribe(onNotification: (n: Notification<'slotsUpdatesSubscribe'>) => void): Subscription {
    return this.subscribe('slotsUpdatesSubscribe', [], onNotification)
  }
  /** maxSupportedTransactionVersion defaults to 1: without it a block holding a v1 transaction arrives as block: null. */
  blockSubscribe(filter: SubscriptionParams<'blockSubscribe'>[0], onNotification: (n: Notification<'blockSubscribe'>) => void, config: SubscriptionParams<'blockSubscribe'>[1] = {}): Subscription {
    return this.subscribe('blockSubscribe', [filter, { maxSupportedTransactionVersion: 1, ...config }], onNotification)
  }

  /** Closes the socket; no reconnect follows. Pending subscriptions are rejected. */
  close(): void {
    this.#closedByUser = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#clearWatchdog()
    const err = new CarbiumError({ kind: 'socket', message: 'the socket was closed' })
    for (const h of this.#handles.values()) if (!h.acked) h.reject(err)
    this.#handles.clear()
    this.#byServerId.clear()
    if (this.#ws && this.#ws.readyState <= 1) this.#ws.close(1000, 'client close')
    this.#setState('closed')
  }

  #setState(s: SocketState, info?: CloseInfo): void {
    this.#state = s
    this.#opts.onState?.(s, info)
  }

  #connect(): void {
    if (!this.#ctor) {
      this.#die(new CarbiumError({ kind: 'socket', message: 'no WebSocket implementation: pass options.WebSocket (for example the ws package) on this runtime' }))
      return
    }
    this.#setState('connecting')
    this.#openedThisConnection = false
    this.#handshakeRetryAfterMs = undefined
    this.#handshakeStatus = undefined
    let ws: WebSocketLike
    try {
      if (this.#apiKey === undefined) ws = new this.#ctor(this.url)
      else if (this.#carrier === 'header') ws = new this.#ctor(this.url, [], { headers: { 'x-api-key': this.#apiKey } })
      else ws = new this.#ctor(this.url, ['carbium', `api-key.${this.#apiKey}`])
    } catch (cause) {
      this.#die(new CarbiumError({ kind: 'socket', message: cause instanceof Error ? cause.message : 'could not open the socket', cause }))
      return
    }
    this.#ws = ws
    ws.on?.('unexpected-response', ((_req: unknown, res: { statusCode?: number; headers?: Record<string, string | string[] | undefined> }) => {
      const status = res.statusCode ?? 0
      this.#handshakeStatus = status
      if (status === 401 || status === 403) this.#fatal = new CarbiumError({ kind: 'auth', httpStatus: status, message: status === 401 ? 'websocket handshake refused: unknown, suspended or revoked key, or no websocket scope' : 'websocket handshake refused: address not allowed or no websocket scope' })
      const ra = res.headers?.['retry-after']
      const raStr = Array.isArray(ra) ? ra[0] : ra
      if (status === 429 && raStr && /^\d+$/.test(raStr)) this.#handshakeRetryAfterMs = Number(raStr) * 1000
      ws.terminate?.() // ws leaves a refused handshake hanging once this event has a listener; terminating emits the close
    }) as never)
    ws.on?.('ping', (() => this.#armWatchdog()) as never)
    ws.addEventListener('open', () => {
      if (ws !== this.#ws) return
      this.#openedThisConnection = true
      this.#attempt = 0
      this.#preOpenFailures = 0
      const reconnect = this.#everOpened
      this.#everOpened = true
      this.#setState('open')
      this.#armWatchdog()
      void this.#rebindAll().then(() => {
        if (reconnect && ws === this.#ws && this.#state === 'open') this.#opts.onReseed?.({ ...this.#lastClose, gap: this.#lastClose.code === 1012 && this.#lastClose.reason === 'stream_gap_reseed_required' })
      })
    })
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data))
    ws.addEventListener('error', () => {
      // A refused handshake fires error, and some runtimes (Node 22's WebSocket) never follow it with close: treat it as 1006.
      if (this.#openedThisConnection) return // after open, the close event that follows carries the decision
      setTimeout(() => {
        if (ws === this.#ws && !this.#openedThisConnection) this.#onClose({ code: 1006, reason: 'handshake failed' })
      }, 50)
    })
    ws.addEventListener('close', (ev) => {
      if (ws !== this.#ws) return
      this.#onClose({ code: ev.code, reason: ev.reason })
    })
  }

  #lastClose: CloseInfo = { code: 0, reason: '' }

  #armWatchdog(): void {
    if (!this.#ws?.on || !this.#ws.terminate) return
    this.#clearWatchdog()
    this.#watchdog = setTimeout(() => this.#ws?.terminate?.(), PING_WATCHDOG_MS)
  }

  #clearWatchdog(): void {
    if (this.#watchdog) clearTimeout(this.#watchdog)
    this.#watchdog = undefined
  }

  #onMessage(data: unknown): void {
    let msg: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown }; method?: unknown; params?: { subscription?: unknown; result?: unknown } }
    try {
      msg = JSON.parse(typeof data === 'string' ? data : String(data))
    } catch {
      return
    }
    if (typeof msg.id === 'number' && this.#pending.has(msg.id)) {
      const p = this.#pending.get(msg.id) as Pending
      this.#pending.delete(msg.id)
      if (msg.error) p.reject(rpcError(p.method, 200, msg.error, null).error)
      else {
        const h = p.bind
        if (h && typeof msg.result === 'number' && h.serverId === undefined && this.#held(h)) {
          h.serverId = msg.result
          this.#byServerId.set(msg.result, h)
          if (!h.acked) {
            h.acked = true
            h.resolve(msg.result)
          }
        }
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && msg.method.endsWith('Notification') && typeof msg.params?.subscription === 'number') {
      const h = this.#byServerId.get(msg.params.subscription)
      if (!h) return
      this.#overloadCloses = 0 // a connection that delivers is not overloaded
      if (msg.method === 'signatureNotification') {
        this.#byServerId.delete(msg.params.subscription)
        for (const [k, v] of this.#handles) if (v === h) this.#handles.delete(k)
      }
      h.onNotification(msg.params.result as never)
    }
  }

  #request(method: string, params: unknown[], bind?: Handle): Promise<unknown> {
    const ws = this.#ws
    if (!ws || this.#state !== 'open') return Promise.reject(new CarbiumError({ kind: 'socket', method, message: 'the socket is not open' }))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject, bind })
      try {
        ws.send(JSON.stringify(params.length === 0 ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }))
      } catch (cause) {
        this.#pending.delete(id)
        reject(new CarbiumError({ kind: 'socket', method, message: cause instanceof Error ? cause.message : 'send failed', cause }))
      }
    })
  }

  #held(h: Handle): boolean {
    for (const v of this.#handles.values()) if (v === h) return true
    return false
  }

  #drop(h: Handle, err: CarbiumError): void {
    for (const [k, v] of this.#handles) if (v === h) this.#handles.delete(k)
    if (h.acked) this.#opts.onError?.(err)
    else h.reject(err)
  }

  async #bind(h: Handle): Promise<void> {
    const ws = this.#ws
    for (let attempt = 1; ; attempt++) {
      if (ws !== this.#ws || h.serverId !== undefined || !this.#held(h)) return // the connection changed, another bind won, or the caller left
      let result: unknown
      try {
        result = await this.#request(h.method, h.params, h)
      } catch (e) {
        const err = e as CarbiumError
        if (err.kind === 'socket') return // the close handler rebinds on the next connection
        const retryable = err.code === -32005 && (err.reason === undefined || RETRY_REASONS.has(err.reason))
        if (retryable && attempt < 4) {
          const backoff = Math.min(4000, 250 * 2 ** (attempt - 1))
          await new Promise((r) => setTimeout(r, Math.max(err.retryAfterMs ?? 1000, backoff) + Math.floor(this.#random() * 251)))
          continue
        }
        if (err.code === -32002) {
          this.#die(err)
          return
        }
        this.#drop(h, err)
        return
      }
      // #onMessage recorded the id; on this connection an id it did not record was unsubscribed before the ack or bound twice: free the server's slot
      if (typeof result === 'number' && ws === this.#ws && h.serverId !== result) void this.#request(h.method.replace(/Subscribe$/, 'Unsubscribe'), [result]).catch(() => undefined)
      return
    }
  }

  async #rebindAll(): Promise<void> {
    const handles = [...this.#handles.values()]
    for (let i = 0; i < handles.length; i += BIND_BATCH) {
      if (this.#state !== 'open') return
      await Promise.all(handles.slice(i, i + BIND_BATCH).map((h) => this.#bind(h)))
    }
  }

  #die(error: CarbiumError): void {
    this.#fatal = error
    for (const h of this.#handles.values()) if (!h.acked) h.reject(error)
    this.#handles.clear()
    this.#byServerId.clear()
    this.#clearWatchdog()
    if (this.#ws && this.#ws.readyState <= 1) this.#ws.close(1000, 'fatal')
    this.#ws = undefined
    this.#setState('closed')
    this.#opts.onFatal?.(error)
  }

  #onClose(info: CloseInfo): void {
    this.#lastClose = info
    this.#ws = undefined
    this.#clearWatchdog()
    const dropped = new CarbiumError({ kind: 'socket', code: info.code, reason: info.reason, message: `socket closed ${info.code} ${info.reason}`.trim() })
    for (const p of this.#pending.values()) p.reject(dropped)
    this.#pending.clear()
    this.#byServerId.clear()
    for (const h of this.#handles.values()) h.serverId = undefined
    if (this.#closedByUser || this.#fatal) {
      if (this.#fatal && this.#state !== 'closed') this.#die(this.#fatal)
      return
    }
    if (this.#handles.size === 0) {
      this.#setState('idle', info)
      return
    }
    const r = this.#random()
    let delay: number
    if (info.code === 1008 && /^key_/.test(info.reason)) return this.#die(new CarbiumError({ kind: 'auth', code: 1008, reason: info.reason, message: `the server closed the socket: ${info.reason}; a human must fix the key` }))
    if (info.code === 1008 && info.reason === 'credits_exhausted') {
      if (this.#creditsExhaustedOnce) return this.#die(new CarbiumError({ kind: 'credits', code: 1008, reason: info.reason, message: 'credits exhausted: buy a plan or upgrade' }))
      this.#creditsExhaustedOnce = true
      delay = 5000
    } else if (info.code === 1008) {
      return this.#die(new CarbiumError({ kind: 'socket', code: 1008, reason: info.reason, message: `the server closed the socket: ${info.reason}` }))
    } else if (info.code === 1013 && info.reason === 'credits_pending') delay = 1000 + r * 500
    else if (info.code === 1013) {
      // slow_consumer or delivery_overload_retry: at least 1 s, and further back after each close in a row (an open does not reset this)
      const cap = Math.min(30_000, 1000 * 2 ** this.#overloadCloses++)
      delay = Math.max(1000, cap / 2 + r * (cap / 2))
    } else if (info.code === 1012 || info.code === 1001) delay = 250 + r * 750
    else {
      // a close before open with no status seen: after five in a row the key is the likely cause (a seen 429 keeps retrying)
      if (!this.#openedThisConnection && this.#handshakeStatus === undefined && ++this.#preOpenFailures >= 5) {
        return this.#die(new CarbiumError({ kind: 'auth', code: info.code, reason: info.reason, message: 'the handshake failed five times in a row with no status: check the key, its websocket scope and the IP allowlist' }))
      }
      const cap = Math.min(30_000, 500 * 2 ** this.#attempt++)
      delay = cap / 2 + r * (cap / 2)
      if (this.#handshakeRetryAfterMs !== undefined) delay = Math.max(delay, this.#handshakeRetryAfterMs)
    }
    this.#setState('backoff', info)
    this.#timer = setTimeout(() => this.#connect(), delay)
  }
}

