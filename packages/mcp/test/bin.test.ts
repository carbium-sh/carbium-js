// The stdio bin end to end: startup line, tool list by key presence, a planted key never in stdout or stderr, --version.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { plantedDoor, doorUrls } from './helpers/door.ts'

const BIN = new URL('../dist/bin.mjs', import.meta.url).pathname
const SERVICE = 'c_serv_' + 'PLANTEDbinservice00000'
const ACCOUNT = 'c_acct_' + 'PLANTEDbinaccount00000'

/** Writes the messages, keeps stdin open until every request id has an answer (a client does the same), then closes. */
function drive(env: Record<string, string>, messages: unknown[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const ids = messages.map((m) => (m as { id?: number }).id).filter((i): i is number => typeof i === 'number')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let closed = false
    const maybeClose = (): void => {
      if (closed) return
      if (ids.every((id) => new RegExp(`"id":${id}[,}]`).test(stdout))) {
        closed = true
        child.stdin.end()
      }
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; maybeClose() })
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, code }))
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
    if (!ids.length) child.stdin.end()
    setTimeout(() => { if (!closed) { closed = true; child.stdin.end(); setTimeout(() => child.kill(), 2000) } }, 12_000)
  })
}
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }
const inited = { jsonrpc: '2.0', method: 'notifications/initialized' }
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }

test('the bin over stdio: with no key it lists five tools and says the public limit; with planted keys it lists more and never prints them, errors included', async (t) => {
  const door = plantedDoor({ serviceKey: SERVICE, accountKey: ACCOUNT })
  const base = await door.start()
  t.after(() => door.stop())
  const urls = doorUrls(base)
  const envUrls = { CARBIUM_ENDPOINT: urls.endpoint, CARBIUM_DASHBOARD_URL: urls.dashboardUrl, CARBIUM_DCA_URL: urls.dcaUrl, CARBIUM_TOKENS_URL: urls.tokensUrl, CARBIUM_DOCS_URLS: urls.docsUrls.join(',') }
  const keyless = await drive(envUrls, [init, inited, list])
  const tools = (l: string): string[] => (JSON.parse(l.trim().split('\n').find((x) => x.includes('"id":2')) as string) as { result: { tools: Array<{ name: string }> } }).result.tools.map((x) => x.name)
  assert.deepEqual(tools(keyless.stdout), ['carbium_docs_search', 'carbium_tokens', 'carbium_dca', 'carbium_rpc', 'carbium_swap'])
  assert.match(keyless.stderr, /service key none \(public methods only, 30 calls a minute per IP address\); account key none; writes off/)
  const keyed = await drive({ ...envUrls, CARBIUM_KEY: SERVICE, CARBIUM_ACCOUNT_KEY: ACCOUNT, CARBIUM_MCP_ALLOW_WRITES: '1' }, [
    init, inited, list,
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'carbium_rpc', arguments: { method: 'getBalance', params: ['x'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'carbium_account', arguments: { action: 'whoami' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'carbium_rpc', arguments: { method: 'getBalance' } } },
  ])
  assert.equal(tools(keyed.stdout).length, 8)
  assert.match(keyed.stderr, /writes on/)
  for (const text of [keyed.stdout, keyed.stderr]) {
    assert.doesNotMatch(text, new RegExp(SERVICE.slice(7)))
    assert.doesNotMatch(text, new RegExp(ACCOUNT.slice(7)))
    assert.doesNotMatch(text, /c_(serv|acct)_[A-Za-z0-9]{5}/)
  }
  assert.ok(keyed.stdout.includes('"id":3') && keyed.stdout.includes('"id":4') && keyed.stdout.includes('"id":5'))
  assert.ok(door.seen.some((s) => s.url === '/rpc'), 'the planted door was called')
})

test('--version prints the version; a malformed key is refused with exit 2 and no key in the message', async () => {
  const v = await drive({}, [])
  assert.equal(v.stderr.includes('v0.1.1'), true)
  const bad = await drive({ CARBIUM_KEY: 'c_acct_' + 'WRONGPLACE000000000000' }, [])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /CARBIUM_KEY must be a full service key/)
  assert.doesNotMatch(bad.stderr, /WRONGPLACE/)
})
