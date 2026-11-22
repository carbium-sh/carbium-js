// GET /cq1/quote, the REST form of the quote: query shape, key in x-api-key only, the plain answer object, the
// plain-text 400, the door's JSON-RPC refusal, and the quote's own retry rules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCarbium, isCarbiumError, type CarbiumError } from '../dist/index.mjs'
import { PlantedServer, rpcErr } from './helpers/planted.ts'

const KEY = 'c_serv_' + 'cq1quote000000000000000'
const SOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const ANSWER = { srcAmountIn: '10000000', destAmountOut: '696754', destAmountOutMin: '693270', swapMode: 'ExactIn', slippage: '50', priceImpactPct: '0.0001', routePlan: [{ swapInfo: { ammKey: 'a', label: 'r-clmm', inputMint: SOL, outputMint: USDC, inAmount: '10000000', outAmount: '696754', feeAmount: '0', feeMint: SOL }, percent: '100', bps: '10000' }], feeMint: SOL, feeBps: '5', signatureFeeLamports: '5000', prioritizationFeeLamports: '0', rentFeeLamports: '0', inputMint: SOL, outputMint: USDC, swapType: 'aggregator', router: 'carbium', requestId: 'r1', priceImpact: '0', extraField: 'tolerated' }
const isKind = (kind: string, more?: (e: CarbiumError) => boolean) => (e: unknown): boolean => isCarbiumError(e) && e.kind === kind && (more ? more(e) : true)

test('cq1Quote sends GET /cq1/quote with the four query params, the key only in x-api-key, and returns the object as served', async (t) => {
  const s = new PlantedServer([{ status: 200, body: ANSWER }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  const q = await c.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: 10_000_000n, slippage_bps: 50 })
  assert.equal(q.destAmountOut, '696754')
  assert.equal(q.routePlan[0]?.swapInfo.label, 'r-clmm')
  assert.equal(q['extraField'], 'tolerated')
  const req = s.seen[0]!
  assert.equal(req.method, 'GET')
  const url = new URL(req.url, 'http://x')
  assert.equal(url.pathname, '/cq1/quote')
  assert.deepEqual([...url.searchParams.keys()].sort(), ['amount_in', 'dst_mint', 'slippage_bps', 'src_mint'])
  assert.equal(url.searchParams.get('amount_in'), '10000000')
  assert.equal(req.headers['x-api-key'], KEY)
  assert.doesNotMatch(req.url, /c_serv_|api[-_]?key/i)
})

test('a parameter fault is a plain-text 400: kind request, the text kept, not retried', async (t) => {
  const s = new PlantedServer([{ status: 400, headers: { 'content-type': 'text/plain' }, body: 'Failed to deserialize query string: missing field `dst_mint`' }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start() })
  await assert.rejects(c.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: '1', slippage_bps: 50 }), isKind('request', (e) => e.httpStatus === 400 && /missing field `dst_mint`/.test(e.message)))
  assert.equal(s.seen.length, 1)
})

test('a key refusal is the door JSON-RPC error object: kind auth with its code and reason, not retried', async (t) => {
  const s = new PlantedServer([rpcErr(401, -32001, 'unknown api key', { reason: 'UNKNOWN_KEY', retryable: false })])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start() })
  await assert.rejects(c.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: '1', slippage_bps: 50 }), isKind('auth', (e) => e.code === -32001 && e.reason === 'UNKNOWN_KEY' && e.requestId === 'rid-1'))
  assert.equal(s.seen.length, 1)
})

test('a 429 is retried after retry-after-ms, as the JSON-RPC quote is', async (t) => {
  const s = new PlantedServer([rpcErr(429, -32005, 'quote lane capacity exceeded: quote_lane', { reason: 'SLOT_CAP_EXCEEDED', retryable: true }, { 'retry-after-ms': '300' }), { status: 200, body: ANSWER }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: { random: () => 0 } })
  const q = await c.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: '1', slippage_bps: 50 })
  assert.equal(q.srcAmountIn, '10000000')
  assert.equal(s.seen.length, 2)
  assert.ok(s.gap(0) >= 300, `waited ${s.gap(0)} ms`)
})

test('a pair with no route is HTTP 422 in plain text: kind route, the text kept, not retried', async (t) => {
  const s = new PlantedServer([{ status: 422, headers: { 'content-type': 'text/plain' }, body: 'No valid routes found' }])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start() })
  await assert.rejects(c.cq1Quote({ src_mint: SOL, dst_mint: 'not-a-mint', amount_in: '1', slippage_bps: 50 }), isKind('route', (e) => e.httpStatus === 422 && /No valid routes found/.test(e.message) && !e.retryable))
  assert.equal(s.seen.length, 1)
})
