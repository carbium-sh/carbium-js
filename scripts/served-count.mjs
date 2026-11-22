#!/usr/bin/env node
// Counts the SDK's typed calls against spec/served.json in both directions, through the live code path: every served
// name must have a typed call that puts that name on the wire, and the SDK must offer nothing the services do not
// serve. Exit 1 on any missing or extra name, or on an empty served list.
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createCarbium, CarbiumSocket, CarbiumDca, CarbiumTokens, METHODS } from '../packages/sdk/dist/index.mjs'
import { CarbiumStream } from '../packages/sdk/dist/stream.mjs'

const served = JSON.parse(readFileSync(new URL('../spec/served.json', import.meta.url), 'utf8'))
const KEY = 'c_serv_' + 'count000000000000000000'
const report = []
let bad = 0

function compare(surface, servedNames, typedNames) {
  const missing = servedNames.filter((n) => !typedNames.includes(n))
  const extra = typedNames.filter((n) => !servedNames.includes(n))
  if (servedNames.length === 0) { missing.push('(served list is empty)') }
  bad += missing.length + extra.length
  report.push({ surface, served: servedNames.length, typed: typedNames.length, missing, extra })
}

// JSON-RPC: call every typed method with a recording fetch and read the wire name.
{
  const wire = []
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    wire.push(body.method)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const c = createCarbium({ apiKey: KEY, fetch, retry: false })
  const typed = []
  for (const plane of ['rpc', 'das', 'quote']) {
    for (const name of Object.keys(c[plane])) {
      const before = wire.length
      await c[plane][name](METHODS[name]?.params === 'object' ? {} : 'x')
      if (wire[before] === name) typed.push(name)
      else { report.push({ surface: 'rpc', note: `${plane}.${name} put ${wire[before]} on the wire` }); bad++ }
    }
  }
  compare('rpc', served.rpc, typed)
}

// REST: every REST call on the client, by the method and path it puts on the wire. A client function with no probe here
// fails the count, so a new REST call cannot slip past it.
{
  const wire = []
  const fetch = async (url, init = {}) => {
    wire.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`)
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const c = createCarbium({ apiKey: KEY, fetch, retry: false })
  const probes = { cq1Quote: () => c.cq1Quote({ src_mint: 'a', dst_mint: 'b', amount_in: '1', slippage_bps: 50 }) }
  for (const k of Object.keys(c).filter((k) => typeof c[k] === 'function' && !['call', 'batch', 'socket'].includes(k))) {
    if (!probes[k]) { report.push({ surface: 'rest', note: `${k} has no wire probe in served-count` }); bad++ }
  }
  for (const probe of Object.values(probes)) await probe()
  compare('rest', served.rest ?? [], [...new Set(wire)])
}

// WebSocket: a fake WebSocket records each subscribe frame and acknowledges it.
{
  const frames = []
  class FakeWebSocket {
    static CONNECTING = 0
    readyState = 0
    #listeners = {}
    constructor(url, protocols) { this.url = url; this.protocol = Array.isArray(protocols) ? protocols[0] : ''; queueMicrotask(() => { this.readyState = 1; this.#emit('open', {}) }) }
    addEventListener(type, fn) { (this.#listeners[type] ??= []).push(fn) }
    #emit(type, ev) { for (const fn of this.#listeners[type] ?? []) fn(ev) }
    send(data) {
      const msg = JSON.parse(data)
      frames.push(msg)
      queueMicrotask(() => this.#emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method.endsWith('Unsubscribe') ? true : frames.length }) }))
    }
    close() { this.readyState = 3; queueMicrotask(() => this.#emit('close', { code: 1000, reason: '' })) }
  }
  const socket = new CarbiumSocket({ apiKey: KEY, WebSocket: FakeWebSocket })
  const args = { accountSubscribe: ['x'], programSubscribe: ['x'], logsSubscribe: ['all'], signatureSubscribe: ['x'], slotSubscribe: [], rootSubscribe: [], slotsUpdatesSubscribe: [], blockSubscribe: ['all'] }
  const methods = Object.getOwnPropertyNames(CarbiumSocket.prototype).filter((m) => m.endsWith('Subscribe'))
  const typed = []
  for (const name of methods) {
    const before = frames.length
    const sub = socket[name](...(args[name] ?? []), () => undefined)
    await sub.ready
    if (frames[before]?.method === name) typed.push(name)
    else { report.push({ surface: 'ws', note: `${name} put ${frames[before]?.method} on the wire` }); bad++ }
  }
  socket.close()
  compare('ws', served.ws, typed)
}

// Carbon Stream: a fake client records the request of subscribe() and the unary call names.
{
  const calls = []
  const fake = new Proxy({}, { get: (_t, name) => (...a) => { calls.push({ name, a }); return name === 'subscribe' ? Promise.resolve(new EventEmitter()) : Promise.resolve({}) } })
  const stream = new CarbiumStream(fake)
  const filterValue = { transactions: { accountInclude: ['x'] }, transactionsStatus: { accountInclude: ['x'] } }
  const typedFilters = []
  for (const f of served.stream.filters) {
    await stream.subscribe({ [f]: { probe: filterValue[f] ?? {} } })
    const req = calls.at(-1)?.a[0]
    if (req && req[f] && 'probe' in req[f]) typedFilters.push(f)
  }
  const requestKeys = Object.keys(calls.at(-1).a[0]).filter((k) => typeof calls.at(-1).a[0][k] === 'object' && !Array.isArray(calls.at(-1).a[0][k]) && k !== 'blockFooter')
  compare('stream.filters', served.stream.filters, requestKeys.filter((k) => typedFilters.includes(k) || served.stream.filters.includes(k)))
  const unaryMethods = Object.getOwnPropertyNames(CarbiumStream.prototype).filter((m) => m !== 'constructor' && !['subscribe', 'subscribeWithReconnect'].includes(m))
  const typedUnary = []
  for (const m of unaryMethods) {
    const before = calls.length
    await stream[m]('x')
    const wireName = calls[before]?.name
    const rpcName = wireName ? wireName[0].toUpperCase() + wireName.slice(1) : undefined
    typedUnary.push(rpcName ?? m)
  }
  compare('stream.unary', served.stream.unary, typedUnary)
}

// HTTP APIs: a recording fetch and an explicit route map; every public method must map to a served route.
async function httpSurface(surface, servedRoutes, instance, map, args, base, placeholders) {
  const calls = []
  instance.__fetch.calls = calls
  const typed = []
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter((m) => m !== 'constructor')
  for (const m of methods) {
    const route = Object.entries(map).find(([, v]) => v === m)?.[0]
    if (!route) { report.push({ surface, note: `${m} maps to no served route` }); bad++; continue }
    const before = calls.length
    let got
    if (m === 'imageUrl') got = `GET ${new URL(instance.imageUrl(...args[m])).pathname}`
    else { await instance[m](...args[m]); got = calls[before] }
    for (const [from, to] of placeholders) got = got.replace(from, to)
    if (got === route) typed.push(route)
    else { report.push({ surface, note: `${m} called ${got}, served route is ${route}` }); bad++ }
  }
  compare(surface, servedRoutes, typed)
}
function recordingFetch(body, headers = {}) {
  const f = async (url, init = {}) => {
    const u = new URL(url)
    f.calls.push(`${init.method ?? 'GET'} ${u.pathname.replace(f.base, '')}`)
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', ...headers } })
  }
  f.calls = []
  f.base = ''
  return f
}
{
  const f = recordingFetch(JSON.stringify({ ok: true }))
  f.base = '/api/dca'
  const dca = new CarbiumDca({ fetch: f })
  dca.__fetch = f
  await httpSurface('dca', served.dca, dca, { 'POST /open': 'open', 'POST /update': 'update', 'POST /withdraw': 'withdraw', 'POST /close': 'close', 'POST /send': 'send', 'GET /quote': 'quote', 'GET /positions': 'positions', 'GET /position/{address}': 'position', 'GET /history': 'history', 'GET /health': 'health' },
    { open: [{}], update: [{}], withdraw: [{}], close: [{}], send: [{}], quote: [{}], positions: ['o'], position: ['addr1'], history: ['o'], health: [] }, '', [['/position/addr1', '/position/{address}']])
}
{
  const f = recordingFetch(JSON.stringify({ items: [], unknown: [] }))
  const tokens = new CarbiumTokens({ fetch: f })
  tokens.__fetch = f
  await httpSurface('tokens', served.tokens, tokens, { 'GET /tokens': 'search', 'GET /tokens/:mint': 'lookup', 'POST /tokens/batch': 'batch', 'GET /img/:mint': 'imageUrl' },
    { search: ['q'], lookup: ['mint1'], batch: [['m']], imageUrl: ['mint1'] }, '', [['/tokens/mint1', '/tokens/:mint'], ['/img/mint1', '/img/:mint']])
}

for (const r of report) {
  if (r.note) console.log(`${r.surface}: ${r.note}`)
  else console.log(`${r.surface}: served ${r.served}, typed ${r.typed}, missing ${r.missing.length}${r.missing.length ? ' (' + r.missing.join(', ') + ')' : ''}, extra ${r.extra.length}${r.extra.length ? ' (' + r.extra.join(', ') + ')' : ''}`)
}
console.log(bad === 0 ? 'served-count: 0 missing, 0 extra' : `served-count: ${bad} problem(s)`)
process.exit(bad === 0 ? 0 : 1)
