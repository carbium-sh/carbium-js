// Regressions from the review round: per-row attempt counts, -32016 sizing, client timeouts, whole-batch refusals,
// malformed 200 answers, the transaction version default, and an Error cause that keeps its detail.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCarbium, isCarbiumError, type CarbiumError } from '../dist/index.mjs'
import { PlantedServer, rpcErr, rpcOk } from './helpers/planted.ts'

const KEY = 'c_serv_' + 'review00000000000000000'
const isKind = (kind: string, test?: (e: CarbiumError) => boolean) => (e: unknown): boolean => isCarbiumError(e) && e.kind === kind && (test ? test(e) : true)

test('getTransaction and getBlock send maxSupportedTransactionVersion 1 by default and keep a caller value', async (t) => {
  const s = new PlantedServer([rpcOk(null)])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  await c.rpc.getTransaction('sig')
  await c.rpc.getBlock(5, { encoding: 'json', maxSupportedTransactionVersion: 0 })
  await c.rpc.getSlot()
  assert.deepEqual(JSON.parse(s.seen[0]!.body).params, ['sig', { maxSupportedTransactionVersion: 1 }])
  assert.deepEqual(JSON.parse(s.seen[1]!.body).params, [5, { maxSupportedTransactionVersion: 0, encoding: 'json' }])
  assert.equal(JSON.parse(s.seen[2]!.body).params, undefined)
})

test('the 429 -32010 scan-index row gets about 6 tries by default, 4 when the caller caps it', async (t) => {
  const row = rpcErr(429, -32010, 'scan index temporarily unavailable, retry', { reason: 'CHOT_INDEX_UNAVAILABLE', retryable: true }, { 'retry-after-ms': '100' })
  const s = new PlantedServer([row])
  t.after(() => s.stop())
  const endpoint = await s.start()
  await assert.rejects(createCarbium({ apiKey: KEY, endpoint, retry: { random: () => 0 } }).rpc.getProgramAccounts('p'), isKind('rate_limit'))
  assert.equal(s.seen.length, 6)
  await assert.rejects(createCarbium({ apiKey: KEY, endpoint, retry: { random: () => 0, maxAttempts: 2 } }).rpc.getProgramAccounts('p'), isKind('rate_limit'))
  assert.equal(s.seen.length, 8)
})

test('-32016 waits about 220 ms per missing slot, read from the call own minContextSlot', async (t) => {
  const s = new PlantedServer([rpcErr(200, -32016, 'Minimum context slot has not been reached', { contextSlot: 100 })])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: { random: () => 0, maxAttempts: 2 } })
  await assert.rejects(c.rpc.getAccountInfo('x', { minContextSlot: 105 }), isKind('node', (e) => e.code === -32016))
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 1100 && s.gap(0) < 1700, `waited ${s.gap(0)} ms for 5 missing slots`)
})

test('a client-side timeout is tried once more, then thrown as transport with its cause', async (t) => {
  const s = new PlantedServer([{ ...rpcOk(1), delayMs: 1500 }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), timeoutMs: 150, retry: { random: () => 0 } })
  await assert.rejects(c.rpc.getSlot(), isKind('transport', (e) => (e.cause as Error | undefined)?.name === 'TimeoutError'))
  assert.equal(s.seen.length, 2)
})

test('a batch the door refuses as a whole throws once: as a 400 array with id null, and as a 200 array of one reason', async (t) => {
  const refused = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch exceeds the cardinality cap', data: { reason: 'BATCH_TOO_LARGE', retryable: false } } }
  const s = new PlantedServer([
    { status: 400, body: [refused] },
    (req) => ({ status: 200, body: (JSON.parse(req.body) as Array<{ id: number }>).map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32600, message: 'scan is not batchable', data: { reason: 'SCAN_NOT_BATCHABLE', retryable: false } } })) }),
  ])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: { random: () => 0 } })
  await assert.rejects(c.batch([{ method: 'getSlot' }, { method: 'getHealth' }]), isKind('request', (e) => e.reason === 'BATCH_TOO_LARGE'))
  await assert.rejects(c.batch([{ method: 'getSlot' }, { method: 'getHealth' }]), isKind('request', (e) => e.reason === 'SCAN_NOT_BATCHABLE'))
  assert.equal(s.seen.length, 2)
  await assert.rejects(c.transport.batch([{ method: 'getSlot' }, { method: 'requestAirdrop' }]), isKind('request', (e) => e.code === -32601))
  assert.equal(s.seen.length, 2)
})

test('a 200 answer that is not a JSON-RPC object is an upstream error, never a raw TypeError', async (t) => {
  const s = new PlantedServer([{ status: 200, body: 'null' }, { status: 200, body: '<html>proxy</html>' }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  await assert.rejects(c.rpc.getSlot(), isKind('upstream', (e) => e.requestId === 'rid-1'))
  await assert.rejects(c.rpc.getSlot(), isKind('upstream', (e) => /proxy/.test(e.message)))
})

test('a network error keeps its cause as an Error with name, message and code', async () => {
  const c = createCarbium({ apiKey: KEY, endpoint: 'http://127.0.0.1:9', retry: false })
  await assert.rejects(c.rpc.getSlot(), isKind('transport', (e) => e.cause instanceof Error && e.cause.name === 'TypeError' && /fetch failed/.test(e.cause.message) && e.cause.cause instanceof Error))
})
