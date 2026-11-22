// The WebSocket client against a fake csocket: auth carrier, routing, and the close-code reconnect table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer, WebSocket as NodeWs } from 'ws'
import type { AddressInfo, Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { CarbiumSocket, type CarbiumError, type WebSocketConstructor } from '../dist/index.mjs'

const KEY = 'c_serv_' + 'wskey00000000000000000'

interface Fake {
  url: string
  received: Array<{ method: string; params?: unknown[] }>
  handshakes: IncomingMessage[]
  connections: number
  closeAll(code: number, reason: string): void
  notify(serverId: number, method: string, result: unknown): void
  stop(): Promise<void>
}

function fakeServer(opts: { refuse?: { status: number; headers?: Record<string, string> }; refuseFirst?: number; ackDelayMs?: number; ackWith?: (connection: number) => { method: string; result: unknown } | undefined } = {}): Promise<Fake> {
  return new Promise((resolve) => {
    let nextId = 100
    const sockets = new Set<NodeWs>()
    const fake: Fake = { url: '', received: [], handshakes: [], connections: 0, closeAll: () => undefined, notify: () => undefined, stop: async () => undefined }
    const wss = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      handleProtocols: (protocols) => (protocols.has('carbium') ? 'carbium' : false),
      verifyClient: (info, cb) => {
        fake.handshakes.push(info.req)
        if (opts.refuse && (opts.refuseFirst === undefined || fake.handshakes.length <= opts.refuseFirst)) return cb(false, opts.refuse.status, 'refused', opts.refuse.headers ?? {})
        cb(true)
      },
    })
    wss.on('connection', (ws) => {
      const connection = ++fake.connections
      sockets.add(ws)
      ws.on('close', () => sockets.delete(ws))
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: unknown[] }
        fake.received.push({ method: msg.method, ...(msg.params ? { params: msg.params } : {}) })
        const reply = msg.method.endsWith('Subscribe') ? { jsonrpc: '2.0', id: msg.id, result: nextId++ } : { jsonrpc: '2.0', id: msg.id, result: true }
        const note = msg.method.endsWith('Subscribe') ? opts.ackWith?.(connection) : undefined
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return
          const tcp = (ws as unknown as { _socket: Socket })._socket // corked, the ack and its notification leave in one write and reach the client in one read
          tcp.cork()
          ws.send(JSON.stringify(reply))
          if (note) ws.send(JSON.stringify({ jsonrpc: '2.0', method: note.method, params: { subscription: reply.result, result: note.result } }))
          tcp.uncork()
        }, msg.method.endsWith('Subscribe') ? (opts.ackDelayMs ?? 0) : 0)
      })
    })
    fake.closeAll = (code, reason) => { for (const s of sockets) s.close(code, reason) }
    fake.notify = (serverId, method, result) => { for (const s of sockets) s.send(JSON.stringify({ jsonrpc: '2.0', method, params: { subscription: serverId, result } })) }
    fake.stop = () => new Promise<void>((r) => { for (const s of sockets) s.terminate(); wss.close(() => r()) })
    wss.on('listening', () => { fake.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`; resolve(fake) })
  })
}

const until = (cond: () => boolean, ms = 8000): Promise<void> => new Promise((res, rej) => {
  const t0 = Date.now()
  const tick = (): void => { if (cond()) res(); else if (Date.now() - t0 > ms) rej(new Error('timed out waiting')); else setTimeout(tick, 10) }
  tick()
})

test('subscribe over the global WebSocket: subprotocol carrier, ack, notification routed by server id, no key in the URL', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0 })
  const seen: unknown[] = []
  const sub = socket.accountSubscribe('11111111111111111111111111111111', (n) => seen.push(n), { commitment: 'confirmed' })
  const id = await sub.ready
  assert.equal(id, 100)
  const hs = f.handshakes[0]
  assert.ok(hs)
  assert.equal(hs.headers['sec-websocket-protocol'], `carbium, api-key.${KEY}`)
  assert.equal(hs.url, '/')
  assert.equal(hs.headers['x-api-key'], undefined)
  assert.deepEqual(f.received[0], { method: 'accountSubscribe', params: ['11111111111111111111111111111111', { commitment: 'confirmed' }] })
  f.notify(100, 'accountNotification', { context: { slot: 1 }, value: { lamports: 5 } })
  await until(() => seen.length === 1)
  assert.deepEqual(seen[0], { context: { slot: 1 }, value: { lamports: 5 } })
  await sub.unsubscribe()
  assert.equal(f.received.at(-1)?.method, 'accountUnsubscribe')
  await until(() => socket.state === 'idle')
  socket.close()
})

test('the ws package with the header carrier sends x-api-key and no subprotocol', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, WebSocket: NodeWs as unknown as WebSocketConstructor, carrier: 'header' })
  await socket.slotSubscribe(() => undefined).ready
  assert.equal(f.handshakes[0]?.headers['x-api-key'], KEY)
  assert.equal(f.handshakes[0]?.headers['sec-websocket-protocol'], undefined)
  socket.close()
})

test('close 1013 credits_pending: reconnect after about 1 s, the subscription is bound again with the same params, onReseed fires with gap false', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const reseeds: unknown[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onReseed: (i) => reseeds.push(i) })
  await socket.logsSubscribe({ mentions: ['11111111111111111111111111111111'] }, () => undefined).ready
  const t0 = Date.now()
  f.closeAll(1013, 'credits_pending')
  await until(() => f.connections === 2 && f.received.length === 2)
  assert.ok(Date.now() - t0 >= 1000, `reconnected after ${Date.now() - t0} ms`)
  assert.deepEqual(f.received[1], f.received[0])
  await until(() => reseeds.length === 1)
  assert.deepEqual(reseeds[0], { code: 1013, reason: 'credits_pending', gap: false })
  socket.close()
})

test('close 1012 stream_gap_reseed_required: reconnect at once with jitter, onReseed fires with gap true', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const reseeds: Array<{ gap: boolean }> = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onReseed: (i) => reseeds.push(i) })
  await socket.slotSubscribe(() => undefined).ready
  const t0 = Date.now()
  f.closeAll(1012, 'stream_gap_reseed_required')
  await until(() => reseeds.length === 1)
  assert.ok(Date.now() - t0 < 1200, `took ${Date.now() - t0} ms`)
  assert.equal(reseeds[0]?.gap, true)
  assert.equal(f.connections, 2)
  socket.close()
})

test('close 1008 key_revoked: no reconnect, onFatal with an auth error', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const fatal: CarbiumError[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onFatal: (e) => fatal.push(e) })
  await socket.rootSubscribe(() => undefined).ready
  f.closeAll(1008, 'key_revoked')
  await until(() => fatal.length === 1)
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(f.connections, 1)
  assert.equal(fatal[0]?.kind, 'auth')
  assert.equal(fatal[0]?.reason, 'key_revoked')
  assert.equal(socket.state, 'closed')
})

test('close 1008 credits_exhausted: one reconnect after about 5 s, a second one is fatal with kind credits', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const fatal: CarbiumError[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onFatal: (e) => fatal.push(e) })
  await socket.slotsUpdatesSubscribe(() => undefined).ready
  const t0 = Date.now()
  f.closeAll(1008, 'credits_exhausted')
  await until(() => f.connections === 2, 9000)
  assert.ok(Date.now() - t0 >= 5000, `reconnected after ${Date.now() - t0} ms`)
  await until(() => f.received.length === 2)
  f.closeAll(1008, 'credits_exhausted')
  await until(() => fatal.length === 1)
  assert.equal(fatal[0]?.kind, 'credits')
  assert.equal(f.connections, 2)
})

test('a refused handshake (401) through the global WebSocket shows as 1006 five times, then onFatal; through ws it is fatal at once', async (t) => {
  const f = await fakeServer({ refuse: { status: 401 } })
  t.after(() => f.stop())
  const fatal: CarbiumError[] = []
  const attempts: string[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onFatal: (e) => fatal.push(e), onState: (s) => { if (s === 'connecting') attempts.push(s) } })
  const sub = socket.slotSubscribe(() => undefined)
  await assert.rejects(sub.ready)
  await until(() => fatal.length === 1, 10000)
  assert.equal(attempts.length, 5)
  assert.ok(f.handshakes.length >= 5)
  assert.equal(fatal[0]?.kind, 'auth')
  const before = f.handshakes.length
  const fatal2: CarbiumError[] = []
  const socket2 = new CarbiumSocket({ apiKey: KEY, url: f.url, WebSocket: NodeWs as unknown as WebSocketConstructor, carrier: 'header', onFatal: (e) => fatal2.push(e) })
  await assert.rejects(socket2.slotSubscribe(() => undefined).ready)
  await until(() => fatal2.length === 1)
  assert.equal(fatal2[0]?.httpStatus, 401)
  assert.equal(f.handshakes.length, before + 1)
})

test('signatureSubscribe fires once and is dropped locally; blockSubscribe sends maxSupportedTransactionVersion 1', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0 })
  const seen: unknown[] = []
  const sub = socket.signatureSubscribe('5'.repeat(64), (n) => seen.push(n))
  const id = await sub.ready
  assert.equal(socket.size, 1)
  f.notify(id, 'signatureNotification', { context: { slot: 2 }, value: { err: null } })
  await until(() => seen.length === 1)
  assert.equal(socket.size, 0)
  await sub.unsubscribe()
  assert.equal(f.received.filter((r) => r.method === 'signatureUnsubscribe').length, 0)
  await socket.blockSubscribe('all', () => undefined, { commitment: 'confirmed' }).ready
  assert.deepEqual(f.received.at(-1)?.params, ['all', { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
  socket.close()
})

test('a key in the url or an account key is refused before any connection', () => {
  assert.throws(() => new CarbiumSocket({ apiKey: 'c_acct_' + 'x'.repeat(10) }), (e: CarbiumError) => e.kind === 'auth')
  assert.throws(() => new CarbiumSocket({ url: 'wss://example.test/?api-key=' + 'x'.repeat(10) }), (e: CarbiumError) => e.kind === 'request')
})

test('unsubscribe before the ack frees the server slot: the Unsubscribe goes out once the ack arrives', async (t) => {
  const f = await fakeServer({ ackDelayMs: 150 })
  t.after(() => f.stop())
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0 })
  const keep = socket.slotSubscribe(() => undefined)
  const dropped = socket.accountSubscribe('11111111111111111111111111111111', () => undefined)
  await new Promise((r) => setTimeout(r, 30))
  await dropped.unsubscribe()
  await assert.rejects(dropped.ready)
  await keep.ready
  await until(() => f.received.some((r) => r.method === 'accountUnsubscribe'))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(f.received.filter((r) => r.method === 'accountUnsubscribe').map((r) => r.params), [[101]], 'exactly one Unsubscribe, with the acknowledged id')
  assert.equal(socket.size, 1)
  socket.close()
})

test('unsubscribe from the callback of a notification that came with its ack: exactly one Unsubscribe, with that id', async (t) => {
  const f = await fakeServer({ ackWith: () => ({ method: 'accountNotification', result: { context: { slot: 4 }, value: { lamports: 1 } } }) })
  t.after(() => f.stop())
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0 })
  const seen: unknown[] = []
  const sub = socket.accountSubscribe('11111111111111111111111111111111', (n) => {
    seen.push(n)
    void sub.unsubscribe()
  })
  assert.equal(await sub.ready, 100)
  await until(() => f.received.some((r) => r.method === 'accountUnsubscribe'))
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(seen.length, 1)
  assert.deepEqual(f.received.filter((r) => r.method === 'accountUnsubscribe').map((r) => r.params), [[100]])
  assert.equal(socket.size, 0)
})

test('a 429 handshake seen through ws is retried after Retry-After and never counted as a key refusal', async (t) => {
  const f = await fakeServer({ refuse: { status: 429, headers: { 'retry-after': '1' } }, refuseFirst: 3 })
  t.after(() => f.stop())
  const fatal: CarbiumError[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, WebSocket: NodeWs as unknown as WebSocketConstructor, carrier: 'header', random: () => 0, onFatal: (e) => fatal.push(e) })
  const t0 = Date.now()
  await socket.slotSubscribe(() => undefined).ready
  assert.equal(f.handshakes.length, 4)
  assert.ok(Date.now() - t0 >= 3000, `connected after ${Date.now() - t0} ms, three Retry-After waits of 1 s`)
  assert.equal(fatal.length, 0)
  socket.close()
})

test('1013 slow_consumer closes wait at least 1 s and back off further on each close in a row', async (t) => {
  const f = await fakeServer()
  t.after(() => f.stop())
  const opens: number[] = []
  const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onState: (s) => { if (s === 'open') opens.push(Date.now()) } })
  await socket.slotSubscribe(() => undefined).ready
  for (const n of [2, 3, 4]) {
    await until(() => f.connections === n - 1 && f.received.length === n - 1)
    f.closeAll(1013, 'slow_consumer')
    await until(() => opens.length === n, 12000)
  }
  const gaps = opens.slice(1).map((o, i) => o - (opens[i] as number))
  assert.ok(gaps.every((g) => g >= 1000), `gaps ${gaps.join(', ')} ms`)
  assert.ok((gaps[2] as number) >= 2000, `third gap ${gaps[2]} ms`)
  socket.close()
})

const runtimes = [['global WebSocket', {}], ['ws package', { WebSocket: NodeWs as unknown as WebSocketConstructor, carrier: 'header' as const }]] as const

test('an ack and the first notification in one network read: the notification reaches its callback, on both runtimes', async (t) => {
  for (const [name, extra] of runtimes) {
    await t.test(name, async (tt) => {
      const f = await fakeServer({ ackWith: () => ({ method: 'signatureNotification', result: { context: { slot: 2 }, value: { err: null } } }) })
      tt.after(() => f.stop())
      const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, ...extra })
      tt.after(() => socket.close())
      const seen: unknown[] = []
      await socket.signatureSubscribe('5'.repeat(64), (n) => seen.push(n)).ready
      await until(() => seen.length === 1, 1000).catch(() => assert.fail('the notification sent with the ack was lost'))
      await new Promise((r) => setTimeout(r, 50))
      assert.deepEqual(seen, [{ context: { slot: 2 }, value: { err: null } }])
      assert.equal(socket.size, 0)
      assert.equal(f.received.filter((r) => r.method === 'signatureUnsubscribe').length, 0)
    })
  }
})

test('after a reconnect, a re-bind ack and a notification in one network read: the notification reaches its callback, on both runtimes', async (t) => {
  for (const [name, extra] of runtimes) {
    await t.test(name, async (tt) => {
      const f = await fakeServer({ ackWith: (connection) => (connection === 2 ? { method: 'accountNotification', result: { context: { slot: 3 }, value: { lamports: 7 } } } : undefined) })
      tt.after(() => f.stop())
      const reseeds: unknown[] = []
      const socket = new CarbiumSocket({ apiKey: KEY, url: f.url, random: () => 0, onReseed: (i) => reseeds.push(i), ...extra })
      tt.after(() => socket.close())
      const seen: unknown[] = []
      await socket.accountSubscribe('11111111111111111111111111111111', (n) => seen.push(n)).ready
      f.closeAll(1012, 'stream_gap_reseed_required')
      await until(() => reseeds.length === 1)
      await until(() => seen.length === 1, 1000).catch(() => assert.fail('the notification sent with the re-bind ack was lost'))
      assert.deepEqual(seen, [{ context: { slot: 3 }, value: { lamports: 7 } }])
    })
  }
})
