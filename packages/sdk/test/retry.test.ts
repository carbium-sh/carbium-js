// Mark 3: a planted 429 with Retry-After waits at least the header before one retry; a planted -32002 is never retried.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCarbium, isCarbiumError, type CarbiumError } from '../dist/index.mjs'
import { PlantedServer, rpcErr, rpcOk } from './helpers/planted.ts'

const noJitter = { random: () => 0 }
const KEY = 'c_serv_' + 'testkey0000000000000000'

async function run(server: PlantedServer, fn: (c: ReturnType<typeof createCarbium>) => Promise<unknown>): Promise<{ result?: unknown; error?: CarbiumError }> {
  const endpoint = await server.start()
  const carbium = createCarbium({ apiKey: KEY, endpoint, retry: noJitter })
  try {
    return { result: await fn(carbium) }
  } catch (e) {
    if (!isCarbiumError(e)) throw e
    return { error: e }
  } finally {
    await server.stop()
  }
}

test('429 with Retry-After: 2 and no retry-after-ms waits at least 2 s, then one retry succeeds', async () => {
  const s = new PlantedServer([rpcErr(429, -32005, 'rate limit exceeded', { reason: 'RATE_LIMITED', retryable: true }, { 'retry-after': '2' }), rpcOk(123)])
  const { result } = await run(s, (c) => c.rpc.getSlot())
  assert.equal(result, 123)
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 2000, `waited ${s.gap(0)} ms, less than the 2000 ms header`)
  assert.ok(s.gap(0) < 2600, `waited ${s.gap(0)} ms, far over the header`)
})

test('retry-after-ms wins over Retry-After, and the wait is never below the computed backoff', async () => {
  const s = new PlantedServer([rpcErr(429, -32005, 'rate limit exceeded', { reason: 'RATE_LIMITED', retryable: true }, { 'retry-after': '2', 'retry-after-ms': '1200' }), rpcOk(1)])
  const { result } = await run(s, (c) => c.rpc.getSlot())
  assert.equal(result, 1)
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 1200 && s.gap(0) < 1800, `waited ${s.gap(0)} ms`)
})

test('a retryAfterMs in the error data wins over Retry-After when there is no retry-after-ms', async () => {
  const s = new PlantedServer([rpcErr(429, -32005, 'rate limit exceeded', { reason: 'RATE_LIMITED', retryable: true, retryAfterMs: 700 }, { 'retry-after': '3' }), rpcOk(1)])
  const { result } = await run(s, (c) => c.rpc.getSlot())
  assert.equal(result, 1)
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 700 && s.gap(0) < 1300, `waited ${s.gap(0)} ms, not the 700 ms in the data`)
})

test('bad params are sent once; only getTransactionsForAddress -32602 "the walk read no history" is tried again', async () => {
  const address = 'So11111111111111111111111111111111111111112'
  const bad = new PlantedServer([rpcErr(200, -32602, 'invalid params: Invalid param: WrongSize'), rpcOk({ data: [] })])
  const { error } = await run(bad, (c) => c.rpc.getTransactionsForAddress(address))
  assert.equal(bad.seen.length, 1, 'the SDK sent bad params again')
  assert.equal(error?.code, -32602)
  assert.equal(error?.kind, 'request')
  assert.equal(error?.retryable, false)
  const walk = new PlantedServer([rpcErr(200, -32602, 'the walk read no history: no page came back within the time budget'), rpcOk({ data: [] })])
  const { result } = await run(walk, (c) => c.rpc.getTransactionsForAddress(address))
  assert.deepEqual(result, { data: [] })
  assert.equal(walk.seen.length, 2)
  assert.ok(walk.gap(0) >= 250 && walk.gap(0) < 850, `waited ${walk.gap(0)} ms`)
})

test('402 -32002 credits exhausted is never retried, even with a Retry-After header', async () => {
  const s = new PlantedServer([rpcErr(402, -32002, 'credits exhausted', { reason: 'CREDITS_EXHAUSTED', retryable: false }, { 'retry-after': '1' }), rpcOk(1)])
  const { error } = await run(s, (c) => c.rpc.getSlot())
  assert.equal(s.seen.length, 1, 'the SDK sent the call again')
  assert.ok(error)
  assert.equal(error.kind, 'credits')
  assert.equal(error.httpStatus, 402)
  assert.equal(error.code, -32002)
  assert.equal(error.reason, 'CREDITS_EXHAUSTED')
  assert.equal(error.retryable, false)
  assert.equal(error.retryAfterMs, 1000)
  assert.equal(error.requestId, 'rid-1')
  assert.match(error.message, /credits exhausted \(x-request-id: rid-1\)/)
})

test('200 -32002 (a failed preflight, no reason) is a node error and is not retried', async () => {
  const s = new PlantedServer([rpcErr(200, -32002, 'Transaction simulation failed: Blockhash not found', { err: 'BlockhashNotFound', logs: [] }), rpcOk(1)])
  const { error } = await run(s, (c) => c.rpc.simulateTransaction('AQ==', { encoding: 'base64' }))
  assert.equal(s.seen.length, 1)
  assert.equal(error?.kind, 'node')
  assert.equal(error?.code, -32002)
  assert.equal(error?.reason, undefined)
})

test('429 CREDITS_PENDING is retried after retry-after-ms', async () => {
  const s = new PlantedServer([rpcErr(429, -32005, 'credits are still loading', { reason: 'CREDITS_PENDING', retryable: true }, { 'retry-after-ms': '300', 'retry-after': '1' }), rpcOk('ok')])
  const { result } = await run(s, (c) => c.rpc.getHealth())
  assert.equal(result, 'ok')
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 300 && s.gap(0) < 900, `waited ${s.gap(0)} ms`)
})

test('a 503 that never clears is tried exactly 4 times, then thrown as upstream', async () => {
  const s = new PlantedServer([rpcErr(503, -32005, 'overloaded', { reason: 'LOAD_SHED', retryable: true }, { 'retry-after-ms': '100' })])
  const { error } = await run(s, (c) => c.rpc.getSlot())
  assert.equal(s.seen.length, 4)
  assert.equal(error?.kind, 'upstream')
  assert.equal(error?.httpStatus, 503)
  assert.equal(error?.retryable, true)
})

test('sendTransaction is never retried, even on a 503', async () => {
  const s = new PlantedServer([rpcErr(503, -32011, 'upstream RPC unavailable, retry later', undefined, { 'retry-after': '1' }), rpcOk('sig')])
  const { error } = await run(s, (c) => c.rpc.sendTransaction('AQ==', { encoding: 'base64' }))
  assert.equal(s.seen.length, 1)
  assert.equal(error?.kind, 'upstream')
  assert.equal(error?.method, 'sendTransaction')
})

test('retry: false sends once and throws the 429', async () => {
  const s = new PlantedServer([rpcErr(429, -32005, 'rate limit exceeded', { reason: 'RATE_LIMITED', retryable: true }, { 'retry-after-ms': '50' }), rpcOk(1)])
  const endpoint = await s.start()
  const c = createCarbium({ apiKey: KEY, endpoint, retry: false })
  await assert.rejects(c.rpc.getSlot(), (e: unknown) => isCarbiumError(e) && e.kind === 'rate_limit' && e.retryAfterMs === 50)
  assert.equal(s.seen.length, 1)
  await s.stop()
})

test('a server hint above maxHintMs is not waited for: the error carries it', async () => {
  const s = new PlantedServer([rpcErr(503, -32005, 'served from cache only; the cache is filling, retry after Retry-After', undefined, { 'retry-after': '60' }), rpcOk(1)])
  const { error } = await run(s, (c) => c.rpc.getSupply())
  assert.equal(s.seen.length, 1)
  assert.equal(error?.retryAfterMs, 60_000)
  assert.equal(error?.retryable, true)
})

test('a 200 error whose data hint is over maxHintMs is not waited for: it comes back at once with the hint', async (t) => {
  const s = new PlantedServer([rpcErr(200, -32004, 'Block not available for slot 5', { retryAfterMs: 2000 }), rpcOk(null)])
  t.after(() => s.stop())
  const endpoint = await s.start()
  const c = createCarbium({ apiKey: KEY, endpoint, retry: { ...noJitter, maxHintMs: 100 } })
  await assert.rejects(c.rpc.getBlock(5), (e: unknown) => isCarbiumError(e) && e.code === -32004 && e.retryAfterMs === 2000)
  assert.equal(s.seen.length, 1, 'the SDK waited the 2000 ms hint and sent the call again')
})

test('the key travels in x-api-key only, with the solana-client header, and never in the URL', async () => {
  const s = new PlantedServer([rpcOk(1)])
  await run(s, (c) => c.rpc.getSlot())
  const req = s.seen[0]
  assert.ok(req)
  assert.equal(req.headers['x-api-key'], KEY)
  assert.match(String(req.headers['solana-client']), /^js\/@carbium\/sdk@\d+\.\d+\.\d+/)
  assert.equal(req.url, '/')
  assert.equal(req.headers.authorization, undefined)
  const body = JSON.parse(req.body)
  assert.deepEqual(Object.keys(body), ['jsonrpc', 'id', 'method'])
})
