// Batch rules checked locally, secret redaction, the three HTTP clients against planted servers, and the version.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { readFileSync } from 'node:fs'
import { createCarbium, CarbiumAccount, CarbiumDca, CarbiumTokens, isCarbiumError, redactSecrets, VERSION, type CarbiumError } from '../dist/index.mjs'
import { PlantedServer, rpcErr, rpcOk } from './helpers/planted.ts'

const KEY = 'c_serv_' + 'clients000000000000000'
const ACCT = 'c_acct_' + 'clients000000000000000'
const isKind = (kind: string, test?: (e: CarbiumError) => boolean) => (e: unknown): boolean => isCarbiumError(e) && e.kind === kind && (test ? test(e) : true)

test('VERSION equals package.json and jsr.json and goes on the wire', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(VERSION, pkg.version)
  assert.equal((JSON.parse(readFileSync(new URL('../jsr.json', import.meta.url), 'utf8')) as { version: string }).version, pkg.version)
})

test('batch: door rules are refused locally before any request', async (t) => {
  const s = new PlantedServer([rpcOk(1)])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  await assert.rejects(c.batch([]), isKind('request'))
  await assert.rejects(c.batch(Array.from({ length: 101 }, () => ({ method: 'getSlot' }))), isKind('request'))
  await assert.rejects(c.batch([{ method: 'getSlot' }, { method: 'getProgramAccounts', params: ['x'] }]), isKind('request', (e) => /not batchable/.test(e.message)))
  await assert.rejects(c.batch([{ method: 'quote', params: { src_mint: 'a', dst_mint: 'b', amount_in: 1, slippage_bps: 50 } }]), isKind('request'))
  await assert.rejects(c.batch([{ method: 'getAsset', params: { id: 'x' } }, { method: 'getSlot' }]), isKind('request', (e) => /DAS/.test(e.message)))
  await assert.rejects(c.batch([{ method: 'getAccountInfo', params: ['a'] }, { method: 'getTransaction', params: ['b'] }, { method: 'getMultipleAccounts', params: [['c']] }]), isKind('request', (e) => /permit/.test(e.message)))
  await assert.rejects(c.rpc.getMultipleAccounts(Array.from({ length: 2000 }, () => 'x'.repeat(44))), isKind('request', (e) => /51200/.test(e.message)))
  assert.equal(s.seen.length, 0)
})

test('batch: answers come back in request order, per-element errors as { ok: false }', async (t) => {
  const s = new PlantedServer([
    (req) => {
      const calls = JSON.parse(req.body) as Array<{ id: number; method: string }>
      return { status: 200, body: [{ jsonrpc: '2.0', id: calls[1]?.id, error: { code: -32602, message: 'invalid params' } }, { jsonrpc: '2.0', id: calls[0]?.id, result: 7 }, { jsonrpc: '2.0', id: calls[2]?.id, result: 'ok' }] }
    },
  ])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  const r = await c.batch([{ method: 'getSlot' }, { method: 'getBalance', params: ['x'] }, { method: 'getHealth' }])
  assert.deepEqual(r.map((x) => x.ok), [true, false, true])
  assert.equal(r[0].ok && r[0].result, 7)
  assert.equal(!r[1].ok && r[1].error.kind, 'request')
  assert.equal(!r[1].ok && r[1].error.method, 'getBalance')
  const sent = JSON.parse(s.seen[0]?.body ?? '[]') as Array<{ id: number; method: string }>
  assert.deepEqual(sent.map((x) => x.method), ['getSlot', 'getBalance', 'getHealth'])
  assert.ok(sent[0]!.id < sent[1]!.id && sent[1]!.id < sent[2]!.id)
})

test('secrets never appear in an error: message, data, cause, JSON and inspect are redacted', async (t) => {
  const leak = `the door saw ${KEY} at https://x.test/?api-key=${KEY} and ${ACCT} and whsec_${'Q'.repeat(20)}`
  const s = new PlantedServer([rpcErr(400, -32600, leak, { reason: 'MALFORMED_BODY', retryable: false, echo: leak, nested: [leak] })])
  t.after(() => s.stop())
  const c = createCarbium({ apiKey: KEY, endpoint: await s.start(), retry: false })
  let err: CarbiumError | undefined
  try {
    await c.rpc.getSlot()
  } catch (e) {
    if (isCarbiumError(e)) err = e
  }
  assert.ok(err)
  const everywhere = [err.message, err.stack ?? '', JSON.stringify(err), inspect(err, { depth: 9 }), JSON.stringify(err.data)].join('\n')
  assert.doesNotMatch(everywhere, /c_serv_[A-Za-z0-9]{5}/)
  assert.doesNotMatch(everywhere, /c_acct_[A-Za-z0-9]{5}/)
  assert.doesNotMatch(everywhere, /whsec_[A-Za-z0-9]{5}/)
  assert.doesNotMatch(everywhere, /api-key=[A-Za-z0-9]/)
  assert.match(err.message, /c_serv_…/)
  assert.equal(redactSecrets(`Bearer ${ACCT}`), 'Bearer c_acct_…')
  // the 4-character prefix the dashboard shows names a key and stays readable; five or more characters are redacted
  assert.equal(redactSecrets('keys c_serv_AbCd and c_acct_Zz99'), 'keys c_serv_AbCd and c_acct_Zz99')
  assert.equal(redactSecrets('key c_serv_' + 'AbCde'), 'key c_serv_…')
})

test('the RPC client refuses an account key and a key in the endpoint before any call', () => {
  assert.throws(() => createCarbium({ apiKey: ACCT }), isKind('auth'))
  assert.throws(() => createCarbium({ apiKey: KEY, endpoint: `https://x.test/?api-key=${KEY}` }), isKind('request'))
  assert.throws(() => createCarbium({ apiKey: KEY, endpoint: `https://x.test/${KEY}` }), isKind('request'))
})

test('account API: Bearer header, JSON errors with Retry-After, plain-text errors, and the test call path', async (t) => {
  const s = new PlantedServer([
    { status: 200, body: [{ key_id: 1, prefix: 'c_serv_ab', status: 'active' }] },
    { status: 429, headers: { 'retry-after': '37' }, body: { error: 'rate_limited', message: 'too many calls: wait Retry-After seconds' } },
    { status: 415, headers: { 'content-type': 'text/plain' }, body: 'Expected request with `Content-Type: application/json`' },
    { status: 200, body: { event_id: 'evt_test_1', outcome: 'delivered', http_status: 200, reason: '', latency_ms: 90, refusal: null, ts: 1 } },
  ])
  t.after(() => s.stop())
  const a = new CarbiumAccount({ apiKey: ACCT, baseUrl: await s.start() })
  const keys = await a.keys.list()
  assert.equal(keys[0]?.key_id, 1)
  assert.equal(s.seen[0]?.headers.authorization, `Bearer ${ACCT}`)
  assert.equal(s.seen[0]?.url, '/v1/keys')
  await assert.rejects(a.account.balance(), isKind('account', (e) => e.httpStatus === 429 && e.code === 'rate_limited' && e.retryAfterMs === 37_000 && e.requestId === 'rid-2'))
  await assert.rejects(a.keys.create({ name: 'x' }), isKind('account', (e) => e.httpStatus === 415 && /Content-Type/.test(e.message)))
  const r = await a.webhooks.test(7)
  assert.equal(r.outcome, 'delivered')
  assert.equal(s.seen[3]?.url, '/v1/webhooks/7/test')
  assert.equal(s.seen[3]?.method, 'POST')
  assert.throws(() => new CarbiumAccount({ apiKey: KEY }), isKind('auth'))
})

test('DCA API: ok:false bodies become dca errors with their code, bigint amounts travel as strings, the key goes in x-api-key', async (t) => {
  const s = new PlantedServer([
    { status: 400, body: { ok: false, err: 'same_mint', detail: 'inputMint and outputMint are the same' } },
    { status: 200, body: { ok: true, txn_base64: 'AQ==', blockhash: 'h', last_valid_block_height: '450406573', position: 'p', cost: {}, summary: { kind: 'open', owner: 'o', feePayer: 'o', instructions: [] }, authority: 'a', escrowAccount: 'e', index: 0, plan: {} } },
    { status: 429, headers: { 'retry-after': '3' }, body: { ok: false, err: 'rate_limited', detail: 'slow down' } },
    { status: 200, body: { ok: true, keeper: 'k' } },
    { status: 200, body: { ok: false, err: 'rate_limited', detail: 'slow down' } },
    { status: 502, body: '' },
  ])
  t.after(() => s.stop())
  const DCA_KEY = 'dca-test-key-1'
  const d = new CarbiumDca({ baseUrl: await s.start(), apiKey: DCA_KEY })
  await assert.rejects(d.open({ owner: 'o', inputMint: 'm', outputMint: 'm', cycles: 2, amountPerCycle: 10n, frequency: 'daily' }), isKind('dca', (e) => e.code === 'same_mint' && e.httpStatus === 400 && !e.retryable))
  const built = await d.open({ owner: 'o', inputMint: 'a', outputMint: 'b', cycles: 2, totalAmount: 12345678901234567890n, intervalSecs: 3600 })
  assert.equal(built.txn_base64, 'AQ==')
  assert.equal(JSON.parse(s.seen[1]?.body ?? '{}').totalAmount, '12345678901234567890')
  assert.equal(s.seen[1]?.headers['x-api-key'], DCA_KEY)
  assert.equal(s.seen[1]?.url, '/open')
  await assert.rejects(d.quote({ inputMint: 'a', outputMint: 'b', amount: '5' }), isKind('dca', (e) => e.code === 'rate_limited' && e.retryable && e.retryAfterMs === 3000))
  assert.equal(s.seen[2]?.url, '/quote?inputMint=a&outputMint=b&amount=5')
  const h = await d.health()
  assert.equal(h.keeper, 'k')
  // a refusal can arrive with HTTP 200 and ok:false; a rate limit stays retryable by its code
  await assert.rejects(d.quote({ inputMint: 'a', outputMint: 'b', amount: '5' }), isKind('dca', (e) => e.code === 'rate_limited' && e.httpStatus === 200 && e.retryable))
  // an empty error body still says what happened (it was an empty message)
  await assert.rejects(d.health(), isKind('dca', (e) => e.message === 'HTTP 502' && e.retryable))
})

test('DCA send: the body holds exactly the two documented fields; an extra field from an untyped caller is not sent', async (t) => {
  const s = new PlantedServer([{ status: 200, body: { ok: true, kind: 'open', signature: 'sig', sent: true, position: 'p' } }])
  t.after(() => s.stop())
  const d = new CarbiumDca({ baseUrl: await s.start() })
  const request = { txn_base64: 'AQ==', built_txn_base64: 'AA==', extra: true }
  assert.equal((await d.send(request)).signature, 'sig')
  assert.equal(s.seen[0]?.url, '/send')
  assert.deepEqual(JSON.parse(s.seen[0]?.body ?? '{}'), { txn_base64: 'AQ==', built_txn_base64: 'AA==' })
})

test('token API: 404 is null, 429 carries the wait, batch size is checked locally, imageUrl is pure', async (t) => {
  const s = new PlantedServer([
    { status: 404, body: { error: 'not_found', mint: 'x' } },
    { status: 429, headers: { 'retry-after': '12' }, body: { error: 'rate_limited', message: 'slow down', retryAfterSec: 12 } },
    { status: 200, body: { items: [{ mint: 'm', symbol: 'M', decimals: 6 }], unknown: ['u'] } },
    { status: 503, body: '' },
  ])
  t.after(() => s.stop())
  const tk = new CarbiumTokens({ baseUrl: await s.start() })
  assert.equal(await tk.lookup('x'), null)
  await assert.rejects(tk.search('sol', { limit: 5 }), isKind('tokens', (e) => e.code === 'rate_limited' && e.retryAfterMs === 12_000))
  assert.equal(s.seen[1]?.url, '/tokens?q=sol&limit=5')
  const b = await tk.batch(['m', 'u'])
  assert.deepEqual(b.unknown, ['u'])
  await assert.rejects(tk.batch(Array.from({ length: 501 }, () => 'm')), isKind('tokens'))
  assert.equal(s.seen.length, 3)
  // an empty error body still says what happened (it was an empty message)
  await assert.rejects(tk.search('sol'), isKind('tokens', (e) => e.message === 'HTTP 503' && e.retryable))
  assert.equal(tk.imageUrl('So11111111111111111111111111111111111111112'), `${tk.baseUrl}/img/So11111111111111111111111111111111111111112`)
})
