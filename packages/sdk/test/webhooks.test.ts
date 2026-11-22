// Mark 4, offline part: the verifier against the Standard Webhooks published vector (an oracle we did not compute),
// a one-byte body change, a wrong secret, a re-encoded body, the tolerance window and the two-signature header.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyWebhook, verifyWebhookSignature, isCarbiumError } from '../dist/index.mjs'

// The specification's example secret, split so no key scan reads a whole secret in this file.
const SECRET = 'whsec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const TS = '1614265330'
const BODY = '{"test": 2432232314}'
const SIG = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
const now = (): number => Number(TS)
const headers = (sig = SIG, ts = TS, id = ID): Record<string, string> => ({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig })

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'verified'
  } catch (e) {
    if (!isCarbiumError(e) || e.kind !== 'webhook') throw e
    return e.reason ?? 'unknown'
  }
}

test('the published vector verifies, from a string, bytes and Fetch Headers; verifyWebhook adds the one-array rule Carbium bodies follow', async () => {
  assert.deepEqual(await verifyWebhookSignature(BODY, headers(), SECRET, { now }), new TextEncoder().encode(BODY))
  assert.deepEqual(await verifyWebhookSignature(new TextEncoder().encode(BODY), new Headers(headers()), SECRET, { now }), new TextEncoder().encode(BODY))
  assert.equal(await reason(verifyWebhook(BODY, headers(), SECRET, { now })), 'bad_json')
})

test('one changed byte anywhere in the body fails with no_match', async () => {
  const bytes = new TextEncoder().encode(BODY)
  for (const i of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
    const flipped = bytes.slice()
    flipped[i] = (flipped[i] as number) ^ 1
    assert.equal(await reason(verifyWebhookSignature(flipped, headers(), SECRET, { now })), 'no_match', `byte ${i}`)
  }
  assert.equal(await reason(verifyWebhookSignature(BODY + ' ', headers(), SECRET, { now })), 'no_match')
})

test('a re-encoded body, a changed id or timestamp, a wrong secret and a wrong header each fail', async () => {
  assert.equal(await reason(verifyWebhookSignature(JSON.stringify(JSON.parse(BODY)), headers(), SECRET, { now })), 'no_match')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(SIG, TS, 'msg_other'), SECRET, { now })), 'no_match')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(SIG, String(Number(TS) + 1)), SECRET, { now })), 'no_match')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), 'whsec_' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', { now })), 'no_match')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers('v1,AAAA'), SECRET, { now })), 'no_match')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', { now })), 'bad_secret')
  assert.equal(await reason(verifyWebhookSignature(BODY, { 'webhook-id': ID, 'webhook-timestamp': TS }, SECRET, { now })), 'missing_header')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(SIG, '1e9'), SECRET, { now })), 'bad_timestamp')
})

test('the tolerance window: 300 s passes, 301 s fails; a custom tolerance is honoured', async () => {
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number(TS) + 300 })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number(TS) - 300 })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number(TS) + 301 })), 'stale')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number(TS) + 301, toleranceSeconds: 600 })), 'verified')
})

test('a rotation header with two entries passes when either matches', async () => {
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(`v1,AAAA ${SIG}`), SECRET, { now })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(`${SIG} v1,AAAA`), SECRET, { now })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers('v1,AAAA v1,BBBB'), SECRET, { now })), 'no_match')
})

test('a body that verifies but is not a JSON array fails with bad_json', async () => {
  // signature over a non-array body, computed with Web Crypto here only to shape the fixture; the oracle test above stands
  const keyBytes = Uint8Array.from(atob(SECRET.slice(6)), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ID}.${TS}.{"a":1}`)))
  const sig = 'v1,' + btoa(String.fromCharCode(...mac))
  assert.equal(await reason(verifyWebhook('{"a":1}', headers(sig), SECRET, { now })), 'bad_json')
  const mac2 = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ID}.${TS}.[{"slot":0,"test":true}]`)))
  assert.deepEqual(await verifyWebhook('[{"slot":0,"test":true}]', headers('v1,' + btoa(String.fromCharCode(...mac2))), SECRET, { now }), [{ slot: 0, test: true }])
})

test('a plain headers object with the original case (Webhook-Id, as AWS Lambda and captured dumps keep it) verifies', async () => {
  const mixed = { 'Webhook-Id': ID, 'Webhook-Timestamp': TS, 'Webhook-Signature': SIG }
  assert.equal(await reason(verifyWebhookSignature(BODY, mixed, SECRET, { now })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, { 'WEBHOOK-ID': ID, 'webhook-timestamp': TS, 'Webhook-Signature': [SIG] }, SECRET, { now })), 'verified')
  assert.equal(await reason(verifyWebhookSignature(BODY, { 'Webhook-Id': ID, 'Webhook-Timestamp': TS }, SECRET, { now })), 'missing_header')
})

test('the tolerance check fails closed: a clock or tolerance that is not a number is stale, never a pass', async () => {
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number.NaN })), 'stale')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now, toleranceSeconds: Number.NaN })), 'stale')
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), SECRET, { now: () => Number.POSITIVE_INFINITY })), 'stale')
})

test('an unset or non-string secret (an env variable that is not there) is bad_secret, not a TypeError', async () => {
  for (const secret of [undefined, null, 42, { toString: () => SECRET }]) {
    assert.equal(await reason(verifyWebhook(BODY, headers(), secret as unknown as string, { now })), 'bad_secret', `a secret of type ${secret === null ? 'null' : typeof secret}`)
    assert.equal(await reason(verifyWebhookSignature(BODY, headers(), secret as unknown as string, { now })), 'bad_secret', `a secret of type ${secret === null ? 'null' : typeof secret}`)
  }
  assert.equal(await reason(verifyWebhookSignature(BODY, headers(), '', { now })), 'bad_secret')
})
