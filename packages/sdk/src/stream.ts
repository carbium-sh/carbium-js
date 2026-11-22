/**
 * Carbon Stream (Yellowstone gRPC) on Node, on the stock @triton-one/yellowstone-grpc client.
 * @module
 */
import type * as Yellowstone from '@triton-one/yellowstone-grpc'
import type { ClientDuplexStream, CommitmentLevel, GetBlockHeightResponse, GetLatestBlockhashResponse, GetSlotResponse, GetVersionResponse, IsBlockhashValidResponse, PongResponse, SubscribeReplayInfoResponse, SubscribeRequest, SubscribeUpdate } from '@triton-one/yellowstone-grpc'
import { CarbiumError } from './errors.ts'
import { buildRequest, classifyStreamError, DEFAULT_STREAM_ENDPOINT, type StreamFilters } from './stream-core.ts'

export { buildRequest, classifyStreamError, DEFAULT_STREAM_ENDPOINT, type StreamFilters, type StreamAction, type StreamErrorInfo, type GrpcStatus } from './stream-core.ts'

export interface StreamOptions {
  /** The full service key with the grpc scope; sent as x-token metadata. */
  apiKey: string
  /** Default https://services.carbium.sh:9443 */
  endpoint?: string
  /** Default 64 MiB, the published minimum. */
  maxDecodingMessageSize?: number
}

/** The part of the stock client the wrapper uses; a test passes a fake. */
type Client = Yellowstone.default
export type StreamClient = Pick<Client, 'subscribe' | 'getSlot' | 'getBlockHeight' | 'getLatestBlockhash' | 'isBlockhashValid' | 'getVersion' | 'ping' | 'subscribeReplayInfo'>

export interface StreamHandlers {
  /**
   * Every update except pings and pongs. Must not block: a reader that takes no frame for 10 s is cut. A throw stops
   * the stream: done rejects with a CarbiumError carrying the thrown error as its cause.
   */
  onUpdate: (update: SubscribeUpdate) => void
  /**
   * After OUT_OF_RANGE (a gap), or when a resume cannot replay (the floor is past the last slot, or the floor read
   * failed): reload state over RPC, then the stream subscribes again.
   */
  onReseed?: (info: { lastSlot: string | undefined }) => void | Promise<void>
  onStatus?: (event: StreamStatusEvent) => void
}
export type StreamStatusEvent =
  | { type: 'connected'; attempt: number; fromSlot: string | undefined }
  | { type: 'retry'; error: CarbiumError; delayMs: number; attempt: number }
  | { type: 'reseed'; error: CarbiumError | undefined; lastSlot: string | undefined }
  | { type: 'stopped'; error: CarbiumError | undefined }

export interface ReconnectingStream {
  /** Ends the stream; done then resolves. */
  close(): void
  /** Resolves after close(); rejects with the CarbiumError that stopped the stream. */
  readonly done: Promise<void>
}

const PING_EVERY_MS = 10_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
  })
}

/**
 * Carbon Stream (Yellowstone gRPC) on services.carbium.sh:9443 through the stock @triton-one/yellowstone-grpc
 * client, with Carbium's rules applied: refused fields caught locally, the published reconnect table, the in-stream
 * ping every 10 s, OUT_OF_RANGE re-seeding and a resume from the last slot when the retained floor allows it.
 */
export class CarbiumStream {
  readonly client: StreamClient

  constructor(client: StreamClient) {
    this.client = client
  }

  /** Loads the stock client, connects with the key as x-token and returns the wrapper. Node only. */
  static async connect(options: StreamOptions): Promise<CarbiumStream> {
    if (!/^c_serv_[A-Za-z0-9]+$/.test(options.apiKey)) throw new CarbiumError({ kind: 'auth', message: 'apiKey must be the full service key (c_serv_…) with the grpc scope' })
    let mod: { default: new (endpoint: string, xToken: string | undefined, channelOptions: { grpcMaxDecodingMessageSize?: number }) => Client }
    try {
      mod = (await import('@triton-one/yellowstone-grpc')) as unknown as typeof mod
    } catch (cause) {
      throw new CarbiumError({ kind: 'stream', message: 'install @triton-one/yellowstone-grpc (>=10) to use Carbon Stream; its native binary exists for linux-x64 and darwin', cause })
    }
    const client = new mod.default(options.endpoint ?? DEFAULT_STREAM_ENDPOINT, options.apiKey, { grpcMaxDecodingMessageSize: options.maxDecodingMessageSize ?? 64 * 1024 * 1024 })
    try {
      await client.connect()
    } catch (cause) {
      const info = classifyStreamError(cause)
      throw new CarbiumError({ kind: 'stream', reason: info.reason, message: info.message, retryable: info.action !== 'stop', cause })
    }
    return new CarbiumStream(client)
  }

  // The seven unary calls, 1 credit each. A refusal comes back as a CarbiumError of kind 'stream' with its gRPC status.
  async #unary<T>(method: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (cause) {
      const info = classifyStreamError(cause)
      throw new CarbiumError({ kind: 'stream', method, reason: info.reason, message: info.message, retryable: info.action !== 'stop', retryAfterMs: info.retryAfterMs, cause })
    }
  }
  getSlot(commitment?: CommitmentLevel): Promise<GetSlotResponse> {
    return this.#unary('getSlot', () => this.client.getSlot(commitment))
  }
  getBlockHeight(commitment?: CommitmentLevel): Promise<GetBlockHeightResponse> {
    return this.#unary('getBlockHeight', () => this.client.getBlockHeight(commitment))
  }
  getLatestBlockhash(commitment?: CommitmentLevel): Promise<GetLatestBlockhashResponse> {
    return this.#unary('getLatestBlockhash', () => this.client.getLatestBlockhash(commitment))
  }
  isBlockhashValid(blockhash: string, commitment?: CommitmentLevel): Promise<IsBlockhashValidResponse> {
    return this.#unary('isBlockhashValid', () => this.client.isBlockhashValid(blockhash, commitment))
  }
  getVersion(): Promise<GetVersionResponse> {
    return this.#unary('getVersion', () => this.client.getVersion())
  }
  /** The unary Ping costs 1 credit; the in-stream ping subscribeWithReconnect sends costs nothing. */
  ping(count: number): Promise<PongResponse> {
    return this.#unary('ping', () => this.client.ping(count))
  }
  /** The first slot a fromSlot replay can start from. */
  subscribeReplayInfo(): Promise<SubscribeReplayInfoResponse> {
    return this.#unary('subscribeReplayInfo', () => this.client.subscribeReplayInfo())
  }

  /** One plain stream with the whole filter set in its first message. No reconnect, no keepalive: for short reads. */
  subscribe(filters: StreamFilters): Promise<ClientDuplexStream> {
    return this.client.subscribe(buildRequest(filters))
  }

  /** A stream that follows the published reconnect table. The filter set is fixed for its life: open a new one to change it. */
  subscribeWithReconnect(filters: StreamFilters, handlers: StreamHandlers, options: { signal?: AbortSignal; random?: () => number } = {}): ReconnectingStream {
    const base = buildRequest(filters)
    const canResume = base.commitment === undefined || base.commitment === 0
    const random = options.random ?? Math.random
    const ac = new AbortController()
    options.signal?.addEventListener('abort', () => ac.abort(), { once: true })
    const signal = ac.signal
    let current: ClientDuplexStream | undefined
    let lastSlot: string | undefined = base.fromSlot

    const done = (async () => {
      let request: SubscribeRequest = base
      let backoffMs = 2000
      let attempt = 0
      while (!signal.aborted) {
        let error: unknown
        let gotData = false
        let handlerError = undefined as { error: unknown } | undefined
        try {
          const stream = await this.client.subscribe(request)
          if (signal.aborted) {
            stream.destroy()
            break
          }
          current = stream
          handlers.onStatus?.({ type: 'connected', attempt, fromSlot: request.fromSlot })
          let pingId = 0
          let pongPending = false
          const pinger = setInterval(() => {
            if (pongPending) return // the control queue holds 8 messages: never pile pings up
            pongPending = true
            stream.write({ ...base, fromSlot: undefined, ping: { id: ++pingId } } as SubscribeRequest, (e?: Error | null) => e && stream.destroy(e))
          }, PING_EVERY_MS)
          const onAbort = (): void => {
            stream.destroy()
          }
          signal.addEventListener('abort', onAbort, { once: true })
          await new Promise<void>((resolve) => {
            stream.on('data', (update: SubscribeUpdate) => {
              if (handlerError) return
              if (update.pong) {
                pongPending = false
                return
              }
              if (update.ping) return
              gotData = true
              const slot = update.slot?.slot ?? update.transaction?.slot ?? update.transactionStatus?.slot ?? update.account?.slot ?? update.blockMeta?.slot ?? update.block?.slot ?? update.entry?.slot
              if (slot !== undefined) lastSlot = String(slot)
              try {
                handlers.onUpdate(update)
              } catch (e) {
                handlerError = { error: e }
                stream.destroy()
                resolve()
              }
            })
            stream.on('error', (e: unknown) => {
              error = e
              resolve()
            })
            stream.on('end', () => resolve())
            stream.on('close', () => resolve())
          })
          signal.removeEventListener('abort', onAbort)
          clearInterval(pinger)
        } catch (e) {
          error = e
        }
        current = undefined
        if (signal.aborted) break
        if (handlerError) {
          // the caller's own failure: never a stream end to retry, which would replay the same update into it again
          const err = new CarbiumError({ kind: 'stream', message: 'onUpdate threw, so the stream stopped', retryable: false, cause: handlerError.error })
          handlers.onStatus?.({ type: 'stopped', error: err })
          throw err
        }
        const info = classifyStreamError(error)
        const err = new CarbiumError({ kind: 'stream', reason: info.reason, message: info.message, retryable: info.action !== 'stop', retryAfterMs: info.retryAfterMs, cause: error })
        if (info.action === 'stop') {
          handlers.onStatus?.({ type: 'stopped', error: err })
          throw err
        }
        if (gotData) {
          backoffMs = 2000
          attempt = 0
        }
        attempt++
        if (info.action === 'reseed') {
          handlers.onStatus?.({ type: 'reseed', error: err, lastSlot })
          await handlers.onReseed?.({ lastSlot })
          request = { ...base, fromSlot: undefined } as SubscribeRequest
          continue
        }
        const delay = Math.max(info.retryAfterMs, backoffMs) + Math.floor(random() * 1000)
        backoffMs = Math.min(30_000, backoffMs * 2)
        handlers.onStatus?.({ type: 'retry', error: err, delayMs: delay, attempt })
        await sleep(delay, signal)
        if (signal.aborted) break
        request = { ...base, fromSlot: undefined } as SubscribeRequest
        if (canResume && lastSlot !== undefined) {
          // a floor that cannot be read cannot prove the resume replays: re-seed rather than go live over a gap
          const floor = await this.client.subscribeReplayInfo().then((r) => BigInt(r.firstAvailable ?? '0')).catch(() => undefined)
          if (floor !== undefined && BigInt(lastSlot) >= floor) request = { ...base, fromSlot: lastSlot }
          else {
            handlers.onStatus?.({ type: 'reseed', error: undefined, lastSlot })
            await handlers.onReseed?.({ lastSlot })
          }
        }
      }
      handlers.onStatus?.({ type: 'stopped', error: undefined })
    })()
    done.catch(() => undefined)
    return {
      close: () => {
        ac.abort()
        current?.destroy()
      },
      done,
    }
  }
}
