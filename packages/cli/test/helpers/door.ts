// The CLI's own test servers. CliDoor answers a few routes itself (wallet sign-in, an empty Terms answer, a webhook
// that sends an Authorization header, a refused webhook create, rotate answers) and passes every other request to the shared planted
// door unchanged. FakeSocket is a JSON-RPC WebSocket server; FakeStream an h2c gRPC server answering one status, after
// one slot update when given one.
import { createServer, type Server } from 'node:http'
import { createServer as createH2 } from 'node:http2'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { plantedDoor, type DoorOptions } from '../../../mcp/test/helpers/door.ts'
import type { PlantedServer, Reply, Seen } from '../../../sdk/test/helpers/planted.ts'

export const WALLET_MESSAGE = 'carbium.sh sign-in\nwallet nonce n-1\nissued at 2026-11-22T00:00:00Z'

export interface CliDoorOptions extends DoorOptions {
  /** GET /v1/terms answers an empty version: no Terms are asked. */
  emptyTerms?: boolean
}

const listen = (server: { listen(port: number, host: string, cb: () => void): unknown; address(): unknown }): Promise<string> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))

export class CliDoor {
  /** Every request, the ones passed on included. */
  readonly seen: Seen[] = []
  readonly #o: CliDoorOptions
  readonly #inner: PlantedServer
  readonly #server: Server
  #innerUrl = ''

  constructor(o: CliDoorOptions) {
    this.#o = o
    this.#inner = plantedDoor(o)
    this.#server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        const rec: Seen = { at: Date.now(), body, headers: req.headers, url: req.url ?? '', method: req.method ?? '' }
        this.seen.push(rec)
        const own = this.#route(rec)
        const reply = own ? Promise.resolve({ status: own.status, type: 'application/json', text: JSON.stringify(own.body) }) : this.#pass(rec)
        reply.then(
          (r) => {
            res.writeHead(r.status, { 'content-type': r.type })
            res.end(r.text)
          },
          () => {
            res.writeHead(502)
            res.end()
          },
        )
      })
    })
  }

  #route(req: Seen): Reply | undefined {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/rpc/cq1/quote' && req.method === 'GET') return { status: 200, body: { srcAmountIn: '1000', destAmountOut: '7', destAmountOutMin: '6', swapMode: 'ExactIn', slippage: '50', priceImpactPct: '0', routePlan: [], feeMint: 'm', feeBps: '5', signatureFeeLamports: '5000', prioritizationFeeLamports: '0', rentFeeLamports: '0', inputMint: 'a', outputMint: 'b', swapType: 'aggregator', router: 'carbium', requestId: 'r1', priceImpact: '0' } }
    if (p === '/v1/terms' && this.#o.emptyTerms) return { status: 200, body: { version: '', url: '' } }
    if (p === '/v1/auth/wallet') {
      const b = JSON.parse(req.body) as { step: string; wallet: string }
      if (b.step === 'challenge') return { status: 200, body: { nonce_token: 'nt-1', message: WALLET_MESSAGE } }
      return { status: 200, body: { session_token: 'session-' + this.#o.accountKey, account: { account_id: 2, email: null, wallet: b.wallet, status: 'active', created_at: 'x', tier: 'free' } } }
    }
    if (p === '/v1/webhooks/5' && req.method === 'GET') return { status: 200, body: { webhook_id: 5, key_id: 1, name: 'h', url: 'https://h.test/x', status: 'active', status_reason: null, tx_status: 'all', address_count: 1, addresses: ['a'], secret_hint: 'whsec_…ab', has_auth_header: true, consecutive_failures: 0, last_success_at: null, last_failure_at: null, created_at: 'x', updated_at: 'x' } }
    if (p === '/v1/webhooks/5' && req.method === 'PATCH') {
      const b = JSON.parse(req.body) as { url?: string; auth_header?: string }
      return { status: 200, body: { webhook_id: 5, url: b.url ?? 'https://h.test/x', note: `stored header ${b.auth_header ?? '(unchanged)'}` } } // a service echoing the header: the CLI must redact it
    }
    if (p === '/v1/keys/42/rotate') return { status: 200, body: { prefix: 'c_serv_ROT4', raw_key: 'c_serv_' + 'ROTATED00000000000000000' } }
    if (p === '/v1/webhooks/3/rotate') return { status: 200, body: { secret: 'whsec_' + 'ROTATED000000000000000000', secret_hint: 'whsec_…00', previous_valid_until: '2026-11-23T00:00:00Z' } }
    if (p === '/v1/webhooks' && req.method === 'POST' && (JSON.parse(req.body) as { url: string }).url.includes('refused.test')) return { status: 400, body: { error: 'invalid_url', message: 'the url must be https on 443 at a public host name' } }
    return undefined
  }

  async #pass(rec: Seen): Promise<{ status: number; type: string; text: string }> {
    const headers: Record<string, string> = {}
    for (const h of ['content-type', 'accept', 'authorization', 'x-api-key']) if (typeof rec.headers[h] === 'string') headers[h] = rec.headers[h]
    const r = await fetch(this.#innerUrl + rec.url, { method: rec.method, headers, ...(rec.method === 'GET' || rec.method === 'HEAD' ? {} : { body: rec.body }) })
    return { status: r.status, type: r.headers.get('content-type') ?? 'application/json', text: await r.text() }
  }

  async start(): Promise<string> {
    this.#innerUrl = await this.#inner.start()
    return listen(this.#server)
  }

  async stop(): Promise<void> {
    await this.#inner.stop()
    await new Promise<void>((r) => this.#server.close(() => r()))
  }
}

/** JSON-RPC subscriptions over WebSocket: 'notify' acks a subscribe and sends three notifications; 'revoke' acks, then closes 1008 key_revoked. */
export class FakeSocket {
  readonly seen: Array<{ method: string; params: unknown }> = []
  /** The handshake URL of each connection. */
  readonly urls: string[] = []
  readonly #mode: 'notify' | 'revoke'
  #server: WebSocketServer | undefined

  constructor(mode: 'notify' | 'revoke') {
    this.#mode = mode
  }

  async start(): Promise<string> {
    const server = await new Promise<WebSocketServer>((resolve) => {
      const s: WebSocketServer = new WebSocketServer({ port: 0, host: '127.0.0.1', handleProtocols: (p) => (p.has('carbium') ? 'carbium' : false) }, () => resolve(s))
    })
    this.#server = server
    let next = 100
    server.on('connection', (ws, req) => {
      this.urls.push(req.url ?? '')
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as { id: number; method: string; params?: unknown }
        this.seen.push({ method: m.method, params: m.params ?? null })
        if (m.method.endsWith('Unsubscribe')) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: true }))
        if (!m.method.endsWith('Subscribe')) return ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }))
        const sub = next++
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: sub }))
        if (this.#mode === 'revoke') return void setTimeout(() => ws.close(1008, 'key_revoked'), 20)
        const result = (i: number): unknown => (m.method === 'slotSubscribe' ? { slot: 10 + i, parent: 9 + i, root: i } : m.method === 'rootSubscribe' ? i : { context: { slot: 10 + i }, value: { n: i } })
        for (let i = 1; i <= 3; i++) setTimeout(() => ws.send(JSON.stringify({ jsonrpc: '2.0', method: m.method.replace(/Subscribe$/, 'Notification'), params: { subscription: sub, result: result(i) } })), 10 * i)
      })
    })
    return `http://127.0.0.1:${server.address().port}`
  }

  async stop(): Promise<void> {
    for (const c of this.#server?.clients ?? []) c.close(1001, 'going away')
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()))
  }
}

/** An h2c gRPC server that answers every call with one status, for example 16 UNAUTHENTICATED; given an update, Subscribe sends that one slot update first and the status as trailers. */
export class FakeStream {
  /** The gRPC paths called, and whether an x-token came with each. */
  readonly seen: Array<{ path: string; token: boolean }> = []
  readonly #server = createH2()

  constructor(status: number, message: string, update?: { slot: number; createdAt: Date }) {
    this.#server.on('stream', (s, h) => {
      this.seen.push({ path: String(h[':path']), token: typeof h['x-token'] === 'string' })
      const trailers = { 'grpc-status': String(status), 'grpc-message': message }
      if (!update || h[':path'] !== '/geyser.Geyser/Subscribe') return void s.respond({ ':status': 200, 'content-type': 'application/grpc', ...trailers }, { endStream: true })
      s.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
      s.on('wantTrailers', () => s.sendTrailers(trailers))
      s.end(slotUpdate(update))
    })
  }

  start(): Promise<string> {
    return listen(this.#server)
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.#server.close(() => r()))
  }
}

const varint = (n: number): number[] => {
  const b: number[] = []
  for (; n > 127; n = Math.floor(n / 128)) b.push((n % 128) | 128)
  return [...b, n]
}
const field = (tag: number, bytes: number[]): number[] => [tag, ...varint(bytes.length), ...bytes]

/** One gRPC frame holding a SubscribeUpdate (geyser.proto): filters ['cli'] (1), slot (3) {slot, parent}, created_at (11) {seconds, nanos}. */
function slotUpdate(u: { slot: number; createdAt: Date }): Buffer {
  const ms = u.createdAt.getTime()
  const msg = Buffer.from([...field(0x0a, [...Buffer.from('cli')]), ...field(0x1a, [0x08, ...varint(u.slot), 0x10, ...varint(u.slot - 1)]), ...field(0x5a, [0x08, ...varint(Math.floor(ms / 1000)), 0x10, ...varint((ms % 1000) * 1e6)])])
  const head = Buffer.alloc(5)
  head.writeUInt32BE(msg.length, 1)
  return Buffer.concat([head, msg])
}

/** A local URL nothing listens on. */
export async function closedUrl(): Promise<string> {
  const s = createServer()
  const url = await listen(s)
  await new Promise<void>((r) => s.close(() => r()))
  return url
}
