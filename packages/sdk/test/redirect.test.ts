// No request follows a redirect: fetch would carry x-api-key (and the body) to whatever host a 3xx names. Every path,
// JSON-RPC, the REST quote, the account API, DCA and tokens, refuses the 3xx and the second host sees nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCarbium, CarbiumAccount, CarbiumDca, CarbiumTokens, isCarbiumError } from '../dist/index.mjs'
import { PlantedServer } from './helpers/planted.ts'

const KEY = 'c_serv_' + 'redirect0000000000000000'
const ACCT = 'c_acct_' + 'redirect0000000000000000'

test('a 3xx on any path is refused as a transport error, not retried, and the other host never sees the key', async (t) => {
  const other = new PlantedServer([{ status: 200, body: { jsonrpc: '2.0', id: 1, result: 'followed' } }])
  const otherUrl = await other.start()
  t.after(() => other.stop())
  const door = new PlantedServer([(req) => ({ status: 302, headers: { location: `${otherUrl}${req.url}` }, body: '' })])
  const base = await door.start()
  t.after(() => door.stop())
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['rpc', () => createCarbium({ apiKey: KEY, endpoint: base }).rpc.getSlot()],
    ['cq1Quote', () => createCarbium({ apiKey: KEY, endpoint: base }).cq1Quote({ src_mint: 'a', dst_mint: 'b', amount_in: '1', slippage_bps: 50 })],
    ['account', () => new CarbiumAccount({ apiKey: ACCT, baseUrl: base }).keys.list()],
    ['dca', () => new CarbiumDca({ baseUrl: base, apiKey: 'dca-key-1' }).health()],
    ['tokens', () => new CarbiumTokens({ baseUrl: base }).lookup('m')],
  ]
  for (const [name, call] of calls) {
    const before = door.seen.length
    await assert.rejects(call(), (e: unknown) => isCarbiumError(e) && e.kind === 'transport' && e.httpStatus === 302 && /redirect/.test(e.message) && !e.retryable, name)
    assert.equal(door.seen.length - before, 1, `${name}: tried once`)
  }
  assert.equal(other.seen.length, 0, 'the redirect target got no request, so no key')
})
