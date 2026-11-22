// The Carbon Stream wrapper against a fake stock client: the request shape, refused fields, the status table and
// the reconnect loop (stop, re-seed, retry with the published waits, resume from the last slot when the floor allows).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CarbiumStream, buildRequest, classifyStreamError, type StreamClient, type StreamStatusEvent } from '../dist/stream.mjs'
import { isCarbiumError } from '../dist/index.mjs'

class FakeDuplex extends EventEmitter {
  writes: unknown[] = []
  destroyed = false
  write(chunk: unknown, cb?: (e?: Error | null) => void): boolean {
    this.writes.push(chunk)
    cb?.(null)
    return true
  }
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

const napiError = (status: string, message: string): Error => Object.assign(new Error('subscribe stream receive failed'), { cause: new Error(`gRPC status: code: '${status}', message: "${message}"`) })

/** A fake client that plays one scripted stream per subscribe: the script function drives the duplex after it is handed out. */
function fakeClient(scripts: Array<(s: FakeDuplex) => void>, floor = '0'): StreamClient & { requests: unknown[]; replayInfoCalls: number } {
  const requests: unknown[] = []
  const client = {
    requests,
    replayInfoCalls: 0,
    subscribe: async (req: unknown) => {
      requests.push(req)
      const s = new FakeDuplex()
      const play = scripts.shift()
      if (!play) throw new Error('no script left')
      setTimeout(() => play(s), 5)
      return s as never
    },
    subscribeReplayInfo: async () => {
      client.replayInfoCalls++
      return { firstAvailable: floor } as never
    },
    getSlot: async () => ({ slot: '1' }) as never,
    getBlockHeight: async () => ({ blockHeight: '1' }) as never,
    getLatestBlockhash: async () => ({}) as never,
    isBlockhashValid: async () => ({}) as never,
    getVersion: async () => ({}) as never,
    ping: async () => ({}) as never,
  }
  return client
}

test('buildRequest fills every map, keeps blockFooter empty, stringifies fromSlot and refuses what the service refuses', () => {
  const r = buildRequest({ slots: { s: { filterByCommitment: true } }, fromSlot: 42n })
  assert.deepEqual(Object.keys(r).sort(), ['accounts', 'accountsDataSlice', 'blockFooter', 'blocks', 'blocksMeta', 'entry', 'fromSlot', 'slots', 'transactions', 'transactionsStatus'])
  assert.equal(r.fromSlot, '42')
  assert.deepEqual(r.blockFooter, {})
  const refused = (f: Parameters<typeof buildRequest>[0]): boolean => { try { buildRequest(f); return false } catch (e) { return isCarbiumError(e) && e.kind === 'request' } }
  assert.ok(refused({ transactions: { t: { tokenAccounts: 1 } as never } }))
  assert.ok(refused({ transactionsStatus: { t: { cuckooAccountInclude: {} } as never } }))
  assert.ok(refused({ accounts: { a: { cuckooAccountsFilter: {} } as never } }))
  assert.ok(refused({ blocks: { b: { cuckooAccountInclude: {} } as never } }))
  assert.ok(refused({ entry: { e: { includeUpdateParent: true } } }))
  assert.ok(refused({ transactions: { bare: {} as never } }))
  assert.ok(refused({ slots: { s: {} }, fromSlot: 1, commitment: 2 }))
  assert.ok(!refused({ slots: { s: {} }, fromSlot: 1, commitment: 0 }))
})

test('classifyStreamError reads grpc-js codes and the N-API text form, and decides stop, reseed or retry', () => {
  assert.deepEqual(classifyStreamError({ code: 16, message: 'unauthenticated' }).action, 'stop')
  assert.equal(classifyStreamError(napiError('The caller does not have permission to execute the specified operation', 'streaming is not included in this tier')).action, 'stop')
  assert.equal(classifyStreamError(napiError('Operation was attempted past the valid range', 'gap: re-seed required')).action, 'reseed')
  const lagged = classifyStreamError(napiError('Some resource has been exhausted', 'consumer_lagged: your stream fell behind the ring'))
  assert.equal(lagged.action, 'retry')
  assert.equal(lagged.retryAfterMs, 2000)
  assert.equal(classifyStreamError(napiError('Some resource has been exhausted', 'consumer_credits_exhausted: stream egress budget spent')).action, 'stop')
  const loading = classifyStreamError(napiError('The service is currently unavailable', 'credits for this account are still loading on this node; retry after Retry-After'))
  assert.equal(loading.action, 'retry')
  assert.equal(loading.retryAfterMs, 1000)
  assert.equal(classifyStreamError(napiError('Client specified an invalid argument', 'from_slot is only supported on the initial subscribe request')).action, 'stop')
  assert.equal(classifyStreamError(undefined).action, 'retry')
  assert.equal(classifyStreamError({ code: 11 }).status, 'OUT_OF_RANGE')
})

test('the whole filter set goes in the first message; updates reach onUpdate, pings and pongs do not', async () => {
  const client = fakeClient([
    (s) => {
      s.emit('data', { ping: {} })
      s.emit('data', { slot: { slot: '10' } })
      s.emit('data', { pong: { id: 1 } })
      setTimeout(() => s.emit('end'), 5)
    },
    () => undefined,
  ])
  const stream = new CarbiumStream(client)
  const updates: unknown[] = []
  const events: StreamStatusEvent[] = []
  const ac = new AbortController()
  const rs = stream.subscribeWithReconnect({ slots: { s: { filterByCommitment: true } } }, { onUpdate: (u) => updates.push(u), onStatus: (e) => events.push(e) }, { signal: ac.signal, random: () => 0 })
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(updates, [{ slot: { slot: '10' } }])
  const first = client.requests[0] as Record<string, unknown>
  assert.deepEqual(first['slots'], { s: { filterByCommitment: true } })
  for (const k of ['accounts', 'transactions', 'transactionsStatus', 'blocks', 'blocksMeta', 'entry', 'blockFooter']) assert.deepEqual(first[k], {})
  assert.equal(events.find((e) => e.type === 'retry')?.type, 'retry', 'a clean end is a retry')
  rs.close()
  await rs.done
})

test('UNAUTHENTICATED stops the stream: done rejects with kind stream and reason UNAUTHENTICATED, no second subscribe', async () => {
  const client = fakeClient([(s) => s.emit('error', napiError('The request does not have valid authentication credentials for the operation', 'unknown api key'))])
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => undefined })
  await assert.rejects(rs.done, (e: unknown) => isCarbiumError(e) && e.kind === 'stream' && e.reason === 'UNAUTHENTICATED' && !e.retryable)
  assert.equal(client.requests.length, 1)
})

test('OUT_OF_RANGE re-seeds: onReseed runs with the last slot, then the stream subscribes again without fromSlot', async () => {
  const client = fakeClient([
    (s) => {
      s.emit('data', { slot: { slot: '500' } })
      s.emit('error', napiError('Operation was attempted past the valid range', 'gap: re-seed required'))
    },
    () => undefined,
  ])
  const reseeds: unknown[] = []
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} }, fromSlot: 400 }, { onUpdate: () => undefined, onReseed: (i) => { reseeds.push(i) } }, { random: () => 0 })
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(reseeds, [{ lastSlot: '500' }])
  assert.equal(client.requests.length, 2)
  assert.equal((client.requests[0] as { fromSlot?: string }).fromSlot, '400')
  assert.equal((client.requests[1] as { fromSlot?: string }).fromSlot, undefined)
  rs.close()
  await rs.done
})

test('a retry waits at least the published 2 s, then resumes from the last slot when the floor allows; below the floor it re-seeds', async () => {
  const client = fakeClient([
    (s) => {
      s.emit('data', { transaction: { slot: '900' } })
      s.emit('error', napiError('The service is currently unavailable', 'server shutting down, reconnect'))
    },
    (s) => s.emit('error', napiError('The service is currently unavailable', 'cfan downstream unavailable')),
    () => undefined,
  ], '850')
  const events: StreamStatusEvent[] = []
  const reseeds: unknown[] = []
  const t0 = Date.now()
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => undefined, onStatus: (e) => events.push(e), onReseed: (i) => { reseeds.push(i) } }, { random: () => 0 })
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(client.requests.length, 2, 'the second subscribe happened')
  assert.ok(Date.now() - t0 >= 2000)
  const retry = events.find((e) => e.type === 'retry')
  assert.ok(retry && retry.type === 'retry' && retry.delayMs >= 2000)
  assert.equal((client.requests[1] as { fromSlot?: string }).fromSlot, '900', 'resumed from the last slot, above the floor of 850')
  assert.equal(client.replayInfoCalls, 1)
  // the second connection fails too: the backoff doubled to 4 s, so the third subscribe is still pending
  await new Promise((r) => setTimeout(r, 4200))
  assert.equal(client.requests.length, 3)
  rs.close()
  await rs.done
  const client2 = fakeClient([(s) => { s.emit('data', { slot: { slot: '100' } }); s.emit('end') }, () => undefined], '200')
  const reseeds2: unknown[] = []
  const rs2 = new CarbiumStream(client2).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => undefined, onReseed: (i) => { reseeds2.push(i) } }, { random: () => 0 })
  await new Promise((r) => setTimeout(r, 2300))
  assert.deepEqual(reseeds2, [{ lastSlot: '100' }])
  assert.equal((client2.requests[1] as { fromSlot?: string }).fromSlot, undefined)
  rs2.close()
  await rs2.done
})

test('a transactionsStatus update moves the resume point: after UNAVAILABLE the second subscribe carries its slot (it reconnected live, losing the outage)', async (t) => {
  const client = fakeClient([
    (s) => {
      s.emit('data', { transactionStatus: { slot: '100', signature: new Uint8Array(64), isVote: false, index: '0' } })
      s.emit('error', napiError('The service is currently unavailable', 'server shutting down, reconnect'))
    },
    () => undefined,
  ], '50')
  const rs = new CarbiumStream(client).subscribeWithReconnect({ transactionsStatus: { t: { vote: false, accountInclude: [], accountExclude: [], accountRequired: [] } } }, { onUpdate: () => undefined }, { random: () => 0 })
  t.after(() => rs.close())
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(client.requests.length, 2)
  assert.equal((client.requests[1] as { fromSlot?: string }).fromSlot, '100', 'resumed from the last slot, above the floor of 50')
})

test('a failed replay-floor read before a resume re-seeds (it went live silently over the gap)', async (t) => {
  const client = fakeClient([
    (s) => {
      s.emit('data', { slot: { slot: '900' } })
      s.emit('error', napiError('The service is currently unavailable', 'server shutting down, reconnect'))
    },
    () => undefined,
  ])
  client.subscribeReplayInfo = async () => {
    client.replayInfoCalls++
    throw napiError('The service is currently unavailable', 'cfan downstream unavailable')
  }
  const events: StreamStatusEvent[] = []
  const reseeds: unknown[] = []
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => undefined, onStatus: (e) => events.push(e), onReseed: (i) => { reseeds.push(i) } }, { random: () => 0 })
  t.after(() => rs.close())
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(client.replayInfoCalls, 1)
  assert.equal(client.requests.length, 2)
  assert.deepEqual(reseeds, [{ lastSlot: '900' }])
  assert.ok(events.some((e) => e.type === 'reseed' && e.lastSlot === '900'))
  assert.equal((client.requests[1] as { fromSlot?: string }).fromSlot, undefined)
})

test('onUpdate throwing stops the stream: done rejects once with it as the cause, nothing escapes the emitter, no second subscribe (it retried forever)', async (t) => {
  const boom = new Error('handler failed')
  const escaped: unknown[] = []
  const client = fakeClient([
    (s) => {
      try { s.emit('data', { slot: { slot: '10' } }) } catch (e) { escaped.push(e) }
      try { s.emit('data', { slot: { slot: '11' } }) } catch (e) { escaped.push(e) }
      setTimeout(() => s.emit('end'), 5)
    },
    () => undefined,
  ])
  const events: StreamStatusEvent[] = []
  let calls = 0
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => { calls++; throw boom }, onStatus: (e) => events.push(e) }, { random: () => 0 })
  t.after(() => rs.close())
  const settled = await Promise.race([rs.done.then(() => 'resolved', (e: unknown) => e), new Promise((r) => setTimeout(() => r('pending'), 300))])
  assert.ok(isCarbiumError(settled) && settled.kind === 'stream' && !settled.retryable && (settled.cause as Error | undefined)?.message === boom.message, `done rejects with the handler error as cause, got ${String(settled)}`)
  assert.deepEqual(escaped, [])
  assert.equal(calls, 1, 'no update reaches onUpdate after it threw')
  assert.equal(events.filter((e) => e.type === 'stopped').length, 1)
  assert.equal(events.some((e) => e.type === 'retry'), false)
  assert.equal(client.requests.length, 1)
})

/** The native client's error when the machine has no CA certificates (read in a node:24-slim container). */
function noRoots(): Error {
  const root = Object.assign(new Error('no native certs found'), { code: 'InvalidArg' })
  const transport = Object.assign(new Error('transport error', { cause: root }), { code: 'InvalidArg' })
  const grpc = Object.assign(new Error('gRPC transport error: transport error', { cause: transport }), { code: 'InvalidArg' })
  return Object.assign(new Error('invalid TLS configuration for gRPC endpoint', { cause: grpc }), { code: 'InvalidArg' })
}

test('no CA certificates on the machine stops the stream and names the fix (it was UNKNOWN and retried forever)', async (t) => {
  const info = classifyStreamError(noRoots())
  assert.equal(info.action, 'stop')
  assert.equal(info.reason, 'TLS_ROOTS')
  assert.match(info.message, /ca-certificates/)
  assert.match(info.message, /SSL_CERT_FILE/)
  assert.equal(classifyStreamError(napiError('The service is currently unavailable', 'x')).reason, 'UNAVAILABLE', 'other errors keep their status as the reason')
  const client = fakeClient([])
  client.subscribe = async (req: unknown) => {
    client.requests.push(req)
    throw noRoots()
  }
  const events: StreamStatusEvent[] = []
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: () => undefined, onStatus: (e) => events.push(e) }, { random: () => 0 })
  t.after(() => rs.close())
  await assert.rejects(rs.done, (e) => isCarbiumError(e) && e.kind === 'stream' && e.reason === 'TLS_ROOTS' && !e.retryable && /ca-certificates/.test(e.message))
  assert.equal(client.requests.length, 1, 'no retry')
  assert.equal(events.some((e) => e.type === 'retry'), false)
})

test('the seven unary calls go to the stock client; connect refuses an account key before loading anything', async () => {
  const names: string[] = []
  const client = new Proxy({}, { get: (_t, name) => async () => { names.push(String(name)); return {} } }) as unknown as StreamClient
  const s = new CarbiumStream(client)
  await s.getSlot(); await s.getBlockHeight(); await s.getLatestBlockhash(); await s.isBlockhashValid('h'); await s.getVersion(); await s.ping(1); await s.subscribeReplayInfo()
  assert.deepEqual(names, ['getSlot', 'getBlockHeight', 'getLatestBlockhash', 'isBlockhashValid', 'getVersion', 'ping', 'subscribeReplayInfo'])
  await assert.rejects(CarbiumStream.connect({ apiKey: 'c_acct_' + 'x'.repeat(10) }), (e: unknown) => isCarbiumError(e) && e.kind === 'auth')
})

test('close() while subscribe() is still pending destroys the stream it returns and settles done', async () => {
  let handed: FakeDuplex | undefined
  const client = {
    subscribe: async () => {
      await new Promise((r) => setTimeout(r, 60))
      handed = new FakeDuplex()
      return handed as never
    },
    subscribeReplayInfo: async () => ({ firstAvailable: '0' }) as never,
    getSlot: async () => ({}) as never, getBlockHeight: async () => ({}) as never, getLatestBlockhash: async () => ({}) as never,
    isBlockhashValid: async () => ({}) as never, getVersion: async () => ({}) as never, ping: async () => ({}) as never,
  } satisfies StreamClient
  const updates: unknown[] = []
  const rs = new CarbiumStream(client).subscribeWithReconnect({ slots: { s: {} } }, { onUpdate: (u) => updates.push(u) })
  await new Promise((r) => setTimeout(r, 10))
  rs.close()
  await rs.done
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(handed, 'subscribe resolved after close')
  assert.equal(handed.destroyed, true)
  handed.emit('data', { slot: { slot: '1' } })
  assert.deepEqual(updates, [])
})

test('a unary call the service refuses comes back as a stream CarbiumError with its status, not the native client error', async () => {
  const refused = napiError('The request does not have valid authentication credentials for the operation', 'unknown api key')
  const client = new Proxy({}, { get: () => async () => { throw refused } }) as unknown as StreamClient
  const s = new CarbiumStream(client)
  for (const call of [() => s.getSlot(), () => s.getBlockHeight(), () => s.getLatestBlockhash(), () => s.isBlockhashValid('h'), () => s.getVersion(), () => s.ping(1), () => s.subscribeReplayInfo()]) {
    await assert.rejects(call(), (e: unknown) => isCarbiumError(e) && e.kind === 'stream' && e.reason === 'UNAUTHENTICATED' && e.message === 'unknown api key' && !e.retryable)
  }
})
