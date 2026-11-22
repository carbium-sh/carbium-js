// The dashboard session calls: routes, bodies, bearer header, and that a session never travels to the service door.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CarbiumSession, isCarbiumError } from '../dist/index.mjs'
import { PlantedServer } from './helpers/planted.ts'

test('terms, challenge, PIN and wallet sign-in use the documented routes and bodies', async (t) => {
  const s = new PlantedServer([
    { status: 200, body: { version: '2026-10-01', url: 'https://carbium.sh/terms' } },
    { status: 200, body: { challenge: 'abc', difficulty: 18 } },
    { status: 200, body: { pin_token: 'pt' } },
    { status: 200, body: { session_token: 'st', account: { account_id: 1, email: 'a@b.c', wallet: null, status: 'active', created_at: 'x', tier: 'free' } } },
    { status: 200, body: { nonce_token: 'nt', message: 'carbium.sh wants you to sign in' } },
    { status: 400, body: { error: 'bad_request', message: 'proof of work required' } },
    { status: 200, body: { session_token: 'st2', account: { account_id: 2, email: null, wallet: 'W', status: 'active', created_at: 'x', tier: 'free' } } },
  ])
  t.after(() => s.stop())
  const o = { baseUrl: await s.start() }
  assert.deepEqual(await CarbiumSession.terms(o), { version: '2026-10-01', url: 'https://carbium.sh/terms' })
  assert.deepEqual(await CarbiumSession.signupChallenge(o), { challenge: 'abc', difficulty: 18 })
  await CarbiumSession.pinStart({ email: 'a@b.c', terms_version: '2026-10-01', pow: { challenge: 'abc', nonce: 7 } }, o)
  const r = await CarbiumSession.pinVerify({ pin_token: 'pt', code: '123456', terms_version: '2026-10-01' }, o)
  assert.equal(r.session_token, 'st')
  await CarbiumSession.walletChallenge('W', o)
  await assert.rejects(CarbiumSession.walletVerify({ wallet: 'W', nonce_token: 'nt', signature: 'sig' }, o), (e: unknown) => isCarbiumError(e) && e.kind === 'account' && e.httpStatus === 400 && /proof of work required/.test(e.message))
  const r2 = await CarbiumSession.walletVerify({ wallet: 'W', nonce_token: 'nt', signature: 'sig', pow: { challenge: 'abc', nonce: 7 } }, o)
  assert.equal(r2.account.wallet, 'W')
  const paths = s.seen.map((x) => `${x.method} ${x.url}`)
  assert.deepEqual(paths, ['GET /v1/terms', 'GET /v1/signup/challenge', 'POST /v1/login/pin', 'POST /v1/login/pin/verify', 'POST /v1/auth/wallet', 'POST /v1/auth/wallet', 'POST /v1/auth/wallet'])
  assert.deepEqual(JSON.parse(s.seen[2]!.body), { email: 'a@b.c', terms_version: '2026-10-01', pow: { challenge: 'abc', nonce: 7 } })
  assert.deepEqual(JSON.parse(s.seen[4]!.body), { step: 'challenge', wallet: 'W' })
  assert.deepEqual(JSON.parse(s.seen[6]!.body), { step: 'verify', wallet: 'W', nonce_token: 'nt', signature: 'sig', pow: { challenge: 'abc', nonce: 7 } })
  for (const x of s.seen) assert.equal(x.headers.authorization, undefined, 'no bearer on the open routes')
})

test('a session mints and revokes account API keys, lists keys and reveals a secret with its bearer token', async (t) => {
  const s = new PlantedServer([
    { status: 200, body: { api_key_id: 9, name: 'carbium-cli', prefix: 'c_acct_AbCd', access: 'read', scopes: [], ip_allow: [], created_at: 'x', expires_at: null, last_used_at: null, raw_key: 'c_acct_' + 'RAW' } },
    { status: 200, body: [{ key_id: 1, prefix: 'c_serv_AbCd', revoked_at: null }] },
    { status: 200, body: { available: true, raw_key: 'c_serv_' + 'RAW' } },
    { status: 200, body: { api_key_id: 9, revoked: true } },
  ])
  t.after(() => s.stop())
  const session = new CarbiumSession('tok', { baseUrl: await s.start() })
  const made = await session.createAccountApiKey({ name: 'carbium-cli', access: 'read', expires_in_days: 90 })
  assert.equal(made.api_key_id, 9)
  const keys = await session.listKeys()
  assert.equal(keys[0]?.key_id, 1)
  const secret = await session.revealKeySecret(1)
  assert.equal(secret.available, true)
  await session.revokeAccountApiKey(9)
  assert.deepEqual(s.seen.map((x) => `${x.method} ${x.url}`), ['POST /v1/account/api-keys', 'GET /v1/keys', 'POST /v1/keys/1/secret', 'DELETE /v1/account/api-keys/9'])
  for (const x of s.seen) assert.equal(x.headers.authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(s.seen[0]!.body), { name: 'carbium-cli', access: 'read', expires_in_days: 90 })
  assert.throws(() => new CarbiumSession(''), (e: unknown) => isCarbiumError(e) && e.kind === 'auth')
})

test('the session calls the description adds: logout, link a wallet in two steps, remove a module', async (t) => {
  const s = new PlantedServer([
    { status: 204, body: '' },
    { status: 200, body: { nonce_token: 'nt', message: 'link this wallet' } },
    { status: 200, body: { account_id: 1, email: 'a@b.c', wallet: 'W', status: 'active', created_at: 'x', tier: 'free', session_token: 'new' } },
    { status: 200, body: { module: 'quote', label: 'Quote', blurb: '', available: true, enabled: false, plan: null, plans: [], status: null, cancel_at_period_end: null, period_start: null, period_end: null, auto_renew: false, contract: false, linked: false } },
  ])
  t.after(() => s.stop())
  const session = new CarbiumSession('tok', { baseUrl: await s.start() })
  await session.logout()
  await session.linkWalletChallenge('W')
  const linked = await session.linkWallet({ wallet: 'W', nonce_token: 'nt', signature: 'sig' })
  assert.equal(linked.session_token, 'new')
  const m = await session.disableModule('quote')
  assert.equal(m.enabled, false)
  assert.deepEqual(s.seen.map((x) => `${x.method} ${x.url}`), ['POST /v1/logout', 'POST /v1/account/link-wallet', 'POST /v1/account/link-wallet', 'DELETE /v1/modules/quote'])
  assert.deepEqual(JSON.parse(s.seen[1]!.body), { step: 'nonce', wallet: 'W' })
  assert.deepEqual(JSON.parse(s.seen[2]!.body), { step: 'link', wallet: 'W', nonce_token: 'nt', signature: 'sig' })
  for (const x of s.seen) assert.equal(x.headers.authorization, 'Bearer tok')
})

test('terms: an empty version is passed through (no Terms asked); the answer is exactly version and url', async (t) => {
  const s = new PlantedServer([{ status: 200, body: { version: '', url: '' } }])
  t.after(() => s.stop())
  assert.deepEqual(await CarbiumSession.terms({ baseUrl: await s.start() }), { version: '', url: '' })
})
