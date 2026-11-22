// The carbium CLI against the planted door: a planted key never prints; writes are off by default and refuse a read-only
// key; no command signs or sends (walked over every command path); exit codes; sign-in by pasted key, email and wallet;
// the credentials file. CARBIUM_TEST_RUNTIME=<path to bun> runs the same bin under Bun.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliDoor, FakeSocket, FakeStream, WALLET_MESSAGE, closedUrl, type CliDoorOptions } from './helpers/door.ts'
import { main, allCommands } from '../dist/main.mjs'

const SERVICE = 'c_serv_' + 'PLANTEDcliservice000000'
const ACCOUNT = 'c_acct_' + 'PLANTEDcliaccount000000'
const ENV = { CARBIUM_KEY: SERVICE, CARBIUM_ACCOUNT_KEY: ACCOUNT }
const BIN = fileURLToPath(new URL('../dist/bin.mjs', import.meta.url))
const RUNTIME = process.env['CARBIUM_TEST_RUNTIME'] || process.execPath
/** Every run gets --stream-url here unless it names one: no test reaches a real Carbon Stream host. */
const CLOSED = await closedUrl()
const ROOT = mkdtempSync(join(tmpdir(), 'carbium-cli-'))
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }))
const home = (): string => mkdtempSync(join(ROOT, 'h-'))

interface Run { status: number | null; stdout: string; stderr: string; killed: boolean; ms: number }
type Runner = (args: string[], env?: Record<string, string>, input?: string, timeoutMs?: number) => Promise<Run>

/** Spawns the built bin (async, so the servers in this process can answer) with a clean env and its own home. */
function runner(base: string, dir: string): Runner {
  const defaults: Array<[string, string]> = [['--endpoint', `${base}/rpc`], ['--dashboard', base], ['--dca-url', `${base}/dca`], ['--tokens-url', `${base}/tk`], ['--stream-url', CLOSED]]
  return (args, env = {}, input, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const flags = defaults.filter(([f]) => !args.some((a) => a === f || a.startsWith(`${f}=`))).flat()
      const t0 = Date.now()
      const child = spawn(RUNTIME, [BIN, ...args, ...flags], { env: { PATH: process.env['PATH'] ?? '', HOME: dir, XDG_CONFIG_HOME: join(dir, 'cfg'), ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let killed = false
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
      const timer = setTimeout(() => {
        killed = true
        child.kill('SIGKILL')
      }, timeoutMs)
      child.on('error', reject)
      child.on('close', (status) => {
        clearTimeout(timer)
        resolve({ status, stdout, stderr, killed, ms: Date.now() - t0 })
      })
      child.stdin.end(input ?? '')
    })
}

async function door(t: { after(fn: () => Promise<void>): void }, o: Partial<CliDoorOptions> = {}): Promise<{ door: CliDoor; run: Runner; dir: string }> {
  const d = new CliDoor({ serviceKey: SERVICE, accountKey: ACCOUNT, ...o })
  const base = await d.start()
  t.after(() => d.stop())
  const dir = home()
  return { door: d, run: runner(base, dir), dir }
}

const noKey = (r: Pick<Run, 'stdout' | 'stderr'>, label: string): void => {
  const all = r.stdout + r.stderr
  assert.doesNotMatch(all, new RegExp(SERVICE.slice(7)), `${label}: service key printed`)
  assert.doesNotMatch(all, new RegExp(ACCOUNT.slice(7)), `${label}: account key printed`)
  assert.doesNotMatch(all, /c_(serv|acct)_[A-Za-z0-9]{5}/, `${label}: key-shaped value printed`)
  assert.doesNotMatch(all, /whsec_[A-Za-z0-9]{5}/, `${label}: secret printed`)
  assert.doesNotMatch(all, /api-key=[^…\s]/, `${label}: key in a URL printed`)
}

/** No JSON-RPC body (single or batch) names sendTransaction, and no path ends in /send. */
const noSend = (seen: ReadonlyArray<{ url: string; body: string }>): void => {
  for (const s of seen) {
    assert.equal(new URL(s.url, 'http://x').pathname.endsWith('/send'), false, `a request to ${s.url}`)
    if (!s.body.startsWith('{') && !s.body.startsWith('[')) continue
    const parsed = JSON.parse(s.body) as unknown
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) assert.notEqual((call as { method?: unknown }).method, 'sendTransaction', `sendTransaction sent to ${s.url}`)
  }
}

const bodies = (d: CliDoor, method: string, path: string): Array<Record<string, unknown>> => d.seen.filter((s) => s.method === method && new URL(s.url, 'http://x').pathname === path).map((s) => JSON.parse(s.body) as Record<string, unknown>)
const rpcCalls = (d: CliDoor): Array<{ method: string; params: unknown[] }> => d.seen.filter((s) => s.url === '/rpc').map((s) => JSON.parse(s.body) as { method: string; params: unknown[] })

// A base58 encoder of the test's own (BigInt), independent of the CLI's decoder.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes: Uint8Array): string {
  let n = BigInt('0x0' + Buffer.from(bytes).toString('hex'))
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    s = '1' + s
  }
  return s
}
/** An ed25519 wallet whose signature of the sign-in message is 88 characters in base58 (about 81 in 100 are). */
function wallet88(): { pubkey: string; signature: string; raw: Buffer; tries: number } {
  for (let tries = 1; ; tries++) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const raw = sign(null, Buffer.from(WALLET_MESSAGE, 'utf8'), privateKey)
    const signature = b58(raw)
    if (signature.length === 88) return { pubkey: b58(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')), signature, raw, tries }
  }
}

test('the command table: no command signs or sends; every command has a summary and an access class', async () => {
  await main(['--help'], { stdout: () => undefined, stderr: () => undefined, env: {} })
  const cmds = allCommands()
  assert.ok(cmds.length >= 60, `${cmds.length} commands`)
  for (const c of cmds) {
    assert.doesNotMatch(c.path.join(' '), /\b(send|sign|submit|transfer|broadcast)\b/i, c.path.join(' '))
    for (const o of Object.keys(c.options ?? {})) assert.doesNotMatch(o, /private|keypair|mnemonic|seed|signer|secret-key|api-key/i, `${c.path.join(' ')} --${o}`)
    assert.ok(c.summary.length > 10 && c.access)
  }
  assert.ok(cmds.some((c) => c.path.join(' ') === 'rpc'))
  assert.ok(!cmds.some((c) => c.path.includes('sendTransaction')))
})

test('version, help, lists, and a key on the command line is refused', async (t) => {
  const { door: d, run } = await door(t)
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0')
  assert.equal((await run(['--help'])).status, 0)
  const groupHelp = await run(['tokens', '--help'])
  assert.equal(groupHelp.status, 0, 'a group with --help is a help request') // it exited 2
  assert.match(groupHelp.stdout, /usage: carbium tokens <command>/)
  const bareGroup = await run(['tokens'])
  assert.equal(bareGroup.status, 2, 'a group with no command is a usage error')
  assert.match(bareGroup.stdout, /usage: carbium tokens <command>/)
  const list = await run(['rpc', 'list', '--json'])
  assert.equal(list.status, 0)
  const methods = JSON.parse(list.stdout) as Array<{ method: string }>
  assert.equal(methods.length, 53)
  assert.ok(!methods.some((m) => m.method === 'sendTransaction'))
  assert.equal((await run(['das', 'list', '--json'])).status, 0)
  assert.equal((await run(['frobnicate'])).status, 2)
  const argvKey = await run(['login', '--key', SERVICE])
  assert.equal(argvKey.status, 2)
  assert.match(argvKey.stderr, /refused/)
  noKey(argvKey, 'argv key')
  assert.equal((await run(['rpc', 'sendTransaction', '"AQ=="'], ENV)).status, 2)
  assert.equal(d.seen.filter((s) => s.url === '/rpc').length, 0, 'sendTransaction never reached the door')
})

test('a key after = or inside a JSON or key=value argument is refused like a bare one', async (t) => {
  const { door: d, run } = await door(t)
  for (const args of [['rpc', 'getSlot', `--service-key=${SERVICE}`], ['rpc', 'getMultipleAccounts', `["${ACCOUNT}"]`], ['das', 'getAsset', `id=${SERVICE}`], ['webhooks', 'get', '3', `--name=${'whsec_' + 'PLANTED0000'}`]]) {
    const r = await run(args, ENV)
    assert.equal(r.status, 2, `${args[0]}: exit ${r.status} ${r.stderr}`)
    assert.match(r.stderr, /a key or secret on the command line is refused/)
    noKey(r, args.join(' '))
  }
  assert.equal(d.seen.length, 0, 'nothing reached the door')
})

test('global options before the command name still find the command (they printed help and exited 0)', async (t) => {
  const { door: d, run } = await door(t)
  const revoke = await run(['-y', '--allow-writes', 'keys', 'revoke', '42'], ENV)
  assert.equal(revoke.status, 0, revoke.stderr)
  assert.equal(d.seen.filter((s) => s.method === 'POST' && s.url === '/v1/keys/42/revoke').length, 1)
  const slot = await run(['--json', 'rpc', 'getSlot'], ENV)
  assert.equal(slot.status, 0, slot.stderr)
  assert.equal(slot.stdout.trim(), '1234')
  const unknown = await run(['--json', 'nope', 'thing'])
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown command "nope thing"/)
  assert.match((await run(['tokens', 'health'])).stderr, /"health" is not a command of carbium tokens/) // it printed a usage line for a group "tokens health"
  const split = await run(['keys', '--name', 'create', 'x', '--allow-writes'], ENV) // --name would take the command word as its value
  assert.equal(split.status, 2, split.stderr)
  assert.match(split.stderr, /an option of carbium keys create goes after the command name/)
  assert.equal(d.seen.filter((s) => s.method === 'POST' && s.url === '/v1/keys').length, 0)
})

test('--no-input and tokens search --no-token22 parse as themselves (they were read as negations)', async (t) => {
  const { door: d, run } = await door(t)
  const login = await run(['login', '--email', 'a@b.c', '--no-input'])
  assert.equal(login.status, 5, login.stderr)
  assert.match(login.stderr, /input needed; prompts are off \(--no-input\)/)
  const search = await run(['tokens', 'search', 'sol', '--no-token22', '--json'])
  assert.equal(search.status, 0, search.stderr)
  const q = d.seen.filter((s) => s.url.startsWith('/tk/tokens?')).map((s) => new URL(s.url, 'http://x').searchParams)
  assert.equal(q.length, 1)
  assert.equal(q[0]?.get('include_token22'), 'false')
})

test('an address made only of digits goes as a string, not a float; 15 digits or fewer stay a number', async (t) => {
  const { door: d, run } = await door(t)
  assert.equal((await run(['rpc', 'getAccountInfo', '11111111111111111111111111111111'], ENV)).status, 0)
  assert.equal((await run(['rpc', 'getBlockTime', '123456789012345'], ENV)).status, 0)
  const [acct, time] = rpcCalls(d)
  assert.equal(acct?.params[0], '11111111111111111111111111111111')
  assert.equal(time?.params[0], 123456789012345)
})

test('--profile picks the profile for one run and never becomes the stored default; config use does', async (t) => {
  const { run } = await door(t)
  assert.equal((await run(['config', 'set', 'dashboard', 'https://one.example.test', '--profile', 'other'])).status, 0)
  assert.equal((JSON.parse((await run(['config', 'list', '--json'])).stdout) as { profile: string }).profile, 'default')
  assert.deepEqual(JSON.parse((await run(['config', 'get', 'dashboard', '--profile', 'other', '--json'])).stdout), { dashboard: 'https://one.example.test' })
  assert.deepEqual(JSON.parse((await run(['config', 'profiles', '--json'])).stdout), [{ name: 'other', current: false }, { name: 'default', current: true }])
  assert.equal((await run(['config', 'use', 'other'])).status, 0)
  assert.equal((JSON.parse((await run(['config', 'list', '--json'])).stdout) as { profile: string }).profile, 'other')
})

test('a stale temp file of the same PID does not block a save, and a failed save leaves no temp file', async () => {
  const quiet = { stdout: () => undefined, stderr: () => undefined }
  const dir = home()
  writeFileSync(join(dir, `credentials.json.${process.pid}.tmp`), 'left by a crashed run\n')
  assert.equal(await main(['config', 'set', 'dashboard', 'https://one.example.test'], { ...quiet, env: { CARBIUM_CONFIG_DIR: dir } }), 0)
  assert.equal((JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')) as { profiles: { default: { dashboard: string } } }).profiles.default.dashboard, 'https://one.example.test')
  const broken = home()
  mkdirSync(join(broken, 'credentials.json'), { mode: 0o700 }) // the rename onto it fails
  let err = ''
  assert.equal(await main(['config', 'set', 'dashboard', 'https://one.example.test'], { stdout: () => undefined, stderr: (s) => void (err += s), env: { CARBIUM_CONFIG_DIR: broken } }), 1)
  assert.match(err, /EISDIR|EEXIST|ENOTEMPTY|EPERM/)
  assert.deepEqual(readdirSync(broken), ['credentials.json'], 'no temp file left')
})

test('the stream host is the endpoint host name on port 9443, or the profile streamUrl, or --stream-url', async () => {
  const dir = home()
  const endpoints = async (args: string[]): Promise<{ stream: string }> => {
    let out = ''
    assert.equal(await main(['endpoints', '--json', ...args], { stdout: (s) => void (out += s), stderr: () => undefined, env: { CARBIUM_CONFIG_DIR: dir } }), 0)
    return JSON.parse(out) as { stream: string }
  }
  assert.equal((await endpoints([])).stream, 'https://services.carbium.sh:9443')
  assert.equal((await endpoints(['--endpoint', 'https://rpc.example.test:8899/base/path'])).stream, 'https://rpc.example.test:9443')
  assert.equal(await main(['config', 'set', 'streamUrl', 'https://stream.example.test:10000'], { stdout: () => undefined, stderr: () => undefined, env: { CARBIUM_CONFIG_DIR: dir } }), 0)
  assert.equal((await endpoints(['--endpoint', 'https://rpc.example.test:8899'])).stream, 'https://stream.example.test:10000')
  assert.equal((await endpoints(['--stream-url', 'http://127.0.0.1:1'])).stream, 'http://127.0.0.1:1')
})

test('webhooks create and rotate make --secret-file before the service acts; a refused create leaves no file', async (t) => {
  const { door: d, run, dir } = await door(t)
  const taken = join(dir, 'taken.secret')
  writeFileSync(taken, 'keep me\n')
  const create = (file: string, url = 'https://h.test/x'): Promise<Run> => run(['webhooks', 'create', '--key-id', '1', '--url', url, '--address', 'a', '--secret-file', file, '--allow-writes'], ENV)
  const posts = (): number => d.seen.filter((s) => s.method === 'POST' && s.url === '/v1/webhooks').length
  for (const [file, why] of [[taken, /EEXIST/], [join(dir, 'no', 'such', 'folder', 'wh.secret'), /ENOENT/]] as const) {
    const r = await create(file)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /cannot make --secret-file/)
    assert.match(r.stderr, why)
  }
  assert.equal(posts(), 0, 'no webhook made')
  assert.equal(readFileSync(taken, 'utf8'), 'keep me\n')
  const refused = await create(join(dir, 'r.secret'), 'https://refused.test/x')
  assert.equal(refused.status, 1, refused.stderr)
  assert.equal(posts(), 1)
  assert.equal(existsSync(join(dir, 'r.secret')), false, 'the empty file made for the refused create is gone')
  const rotTaken = await run(['webhooks', 'rotate', '3', '--secret-file', taken, '--allow-writes', '-y'], ENV)
  assert.equal(rotTaken.status, 2, rotTaken.stderr)
  assert.equal(d.seen.filter((s) => s.url === '/v1/webhooks/3/rotate').length, 0, 'the secret was not rotated')
  const rot = await run(['webhooks', 'rotate', '3', '--secret-file', join(dir, 'rot.secret'), '--allow-writes', '-y'], ENV)
  assert.equal(rot.status, 0, rot.stderr)
  noKey(rot, 'webhooks rotate')
  assert.match(readFileSync(join(dir, 'rot.secret'), 'utf8'), new RegExp('^whsec_' + 'ROTATED'))
  assert.equal(statSync(join(dir, 'rot.secret')).mode & 0o777, 0o600)
})

test('keys create and rotate make --secret-file before the service acts, like webhooks: a bad path stops the run with no key made', async (t) => {
  const { door: d, run, dir } = await door(t)
  const taken = join(dir, 'taken.key')
  writeFileSync(taken, 'keep me\n')
  for (const [file, why] of [[taken, /EEXIST/], [join(dir, 'no', 'such', 'folder', 'k.key'), /ENOENT/]] as const) {
    const r = await run(['keys', 'create', '--name', 'x', '--secret-file', file, '--allow-writes'], ENV)
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /cannot make --secret-file/)
    assert.match(r.stderr, why)
  }
  assert.equal(d.seen.filter((s) => s.method === 'POST' && s.url === '/v1/keys').length, 0, 'no key made')
  const rot = await run(['keys', 'rotate', '42', '--secret-file', taken, '--allow-writes', '-y'], ENV)
  assert.equal(rot.status, 2, rot.stderr)
  assert.equal(d.seen.filter((s) => s.url === '/v1/keys/42/rotate').length, 0, 'the key was not rotated')
  assert.equal(readFileSync(taken, 'utf8'), 'keep me\n')
  const ok = await run(['keys', 'create', '--name', 'x', '--secret-file', join(dir, 'new.key'), '--allow-writes', '--json'], ENV)
  assert.equal(ok.status, 0, ok.stderr)
  noKey(ok, 'keys create --secret-file')
  assert.match(readFileSync(join(dir, 'new.key'), 'utf8'), new RegExp('^c_serv_' + 'NEWKEY'))
  assert.equal(statSync(join(dir, 'new.key')).mode & 0o777, 0o600)
})

test('keys limits refuses a value that is not a whole number from 0 to 10000 before any request', async (t) => {
  const { door: d, run } = await door(t)
  for (const bad of ['abc', '-1', '10001', '1.5']) {
    const r = await run(['keys', 'limits', '1', '--max-inflight', bad, '--allow-writes'], ENV)
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`)
  }
  assert.equal(d.seen.filter((s) => s.method === 'PATCH').length, 0)
  const ok = await run(['keys', 'limits', '1', '--max-inflight', '0', '--allow-writes'], ENV)
  assert.equal(ok.status, 0, ok.stderr)
})

test('webhooks update keeps the Authorization header: a new URL alone is refused when one is stored; the header and key flags are sent', async (t) => {
  const { door: d, run } = await door(t)
  const patches = (id: number): Array<Record<string, unknown>> => bodies(d, 'PATCH', `/v1/webhooks/${id}`)
  const refused = await run(['webhooks', 'update', '5', '--url', 'https://new.test/x', '--allow-writes'], ENV)
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(refused.stderr, /webhook 5 sends an Authorization header, and a new URL without one clears it/)
  assert.equal(patches(5).length, 0)
  const token = 'Bearer planted-hook-token-77'
  const kept = await run(['webhooks', 'update', '5', '--url', 'https://new.test/x', '--auth-header-env', 'HOOK_AUTH', '--allow-writes'], { ...ENV, HOOK_AUTH: token })
  assert.equal(kept.status, 0, kept.stderr)
  assert.doesNotMatch(kept.stdout + kept.stderr, /planted-hook-token-77/, 'the header is a secret in the output')
  assert.match(kept.stdout, /stored header \[redacted\]/)
  const cleared = await run(['webhooks', 'update', '5', '--url', 'https://new.test/y', '--clear-auth-header', '--allow-writes'], ENV)
  assert.equal(cleared.status, 0, cleared.stderr)
  const keyed = await run(['webhooks', 'update', '5', '--key-id', '9', '--allow-writes'], ENV)
  assert.equal(keyed.status, 0, keyed.stderr)
  assert.deepEqual(patches(5), [{ url: 'https://new.test/x', auth_header: token }, { url: 'https://new.test/y', auth_header: '' }, { key_id: 9 }])
  assert.equal((await run(['webhooks', 'update', '5', '--auth-header-env', 'HOOK_AUTH', '--clear-auth-header', '--allow-writes'], { ...ENV, HOOK_AUTH: token })).status, 2)
  const none = await run(['webhooks', 'update', '3', '--url', 'https://new.test/z', '--allow-writes'], ENV)
  assert.equal(none.status, 0, `a webhook with no stored header takes a new URL: ${none.stderr}`)
  assert.deepEqual(patches(3), [{ url: 'https://new.test/z' }])
})

test('ws tail ends with exit 3 and the error when the server closes a live subscription for a revoked key (it hung under Bun and ended 13 with no word under Node)', async (t) => {
  const ws = new FakeSocket('revoke')
  const url = await ws.start()
  t.after(() => ws.stop())
  const run = runner(await closedUrl(), home())
  const r = await run(['ws', 'tail', 'slot', '--endpoint', url], ENV, undefined, 15_000)
  assert.equal(r.killed, false, `killed after ${r.ms} ms: the tail hung`)
  assert.equal(r.status, 3, r.stderr)
  assert.ok(r.ms < 5000, `${r.ms} ms`)
  assert.match(r.stderr, /key_revoked/)
  noKey(r, 'ws tail revoked')
  assert.deepEqual(ws.seen.map((s) => s.method), ['slotSubscribe'])
  assert.ok(ws.urls.length >= 1 && ws.urls.every((u) => !/api-key/i.test(u)), 'the key never goes in the URL')
})

test('stream tail maps UNAUTHENTICATED and PERMISSION_DENIED to exit 3 and an exhausted RESOURCE_EXHAUSTED to exit 4', async (t) => {
  const run = runner(await closedUrl(), home())
  for (const [status, message, exit] of [[16, 'invalid x-token', 3], [7, 'this key may not use Carbon Stream', 3], [8, 'credits exhausted', 4]] as const) {
    const g = new FakeStream(status, message)
    const url = await g.start()
    t.after(() => g.stop())
    const r = await run(['stream', 'tail', '--slots', '--stream-url', url], ENV, undefined, 20_000)
    assert.equal(r.killed, false, `grpc ${status}: killed after ${r.ms} ms`)
    assert.equal(r.status, exit, `grpc ${status}: ${r.stderr}`)
    noKey(r, `stream tail grpc ${status}`)
    assert.ok(g.seen.some((s) => s.path === '/geyser.Geyser/Subscribe' && s.token), `grpc ${status}: the stream went to --stream-url with its x-token`)
  }
})

test('stream tail prints an update as one JSON line whose createdAt is the ISO time (it was {})', async (t) => {
  const createdAt = new Date('2026-11-22T00:00:00.123Z')
  const g = new FakeStream(0, '', { slot: 381250119, createdAt })
  const url = await g.start()
  t.after(() => g.stop())
  const r = await runner(await closedUrl(), home())(['stream', 'tail', '--slots', '--count', '1', '--stream-url', url], ENV, undefined, 20_000)
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, r.stdout)
  const line = JSON.parse(lines[0] as string) as { createdAt: unknown }
  assert.equal(line.createdAt, createdAt.toISOString())
  assert.deepEqual(line, { filters: ['cli'], slot: { slot: '381250119', parent: '381250118', status: 0 }, createdAt: createdAt.toISOString() })
  noKey(r, 'stream tail one update')
})

test('the stream unary calls map a refused key to exit 3 and credits to exit 4, like the tail', async (t) => {
  const run = runner(await closedUrl(), home())
  for (const [status, message, exit] of [[16, 'invalid x-token', 3], [8, 'credits exhausted', 4]] as const) {
    const g = new FakeStream(status, message)
    const url = await g.start()
    t.after(() => g.stop())
    for (const cmd of ['slot', 'version', 'replay-info']) {
      const r = await run(['stream', cmd, '--stream-url', url], ENV, undefined, 20_000)
      assert.equal(r.killed, false, `stream ${cmd} grpc ${status}: killed after ${r.ms} ms`)
      assert.equal(r.status, exit, `stream ${cmd} grpc ${status}: ${r.stderr}`)
      noKey(r, `stream ${cmd} grpc ${status}`)
    }
  }
})

test('stream calls on a machine with no CA certificates say how to fix it, exit 2, not retryable (it was UNKNOWN, retryable, exit 1)', async () => {
  const run = runner(await closedUrl(), home())
  const noRoots = { ...ENV, SSL_CERT_FILE: join(ROOT, 'no-such-ca.pem'), SSL_CERT_DIR: join(ROOT, 'no-such-dir') }
  for (const cmd of ['slot', 'version']) {
    const r = await run(['stream', cmd, '--stream-url', 'https://127.0.0.1:9'], noRoots, undefined, 20_000)
    assert.equal(r.status, 2, `stream ${cmd}: ${r.stderr}`)
    assert.match(r.stderr, /the stream client needs the system CA certificates: install the ca-certificates package, or set SSL_CERT_FILE to a CA bundle/)
    assert.match(r.stderr, /retryable: no/)
    noKey(r, `stream ${cmd} without CA certificates`)
  }
})

test('quote --rest asks GET /cq1/quote with the four params and the key in x-api-key; --dex with --rest is refused', async (t) => {
  const { door: d, run } = await door(t)
  const r = await run(['quote', 'So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000', '--rest', '--json'], ENV)
  assert.equal(r.status, 0, r.stderr)
  assert.equal((JSON.parse(r.stdout) as { destAmountOutMin: string }).destAmountOutMin, '6')
  const get = d.seen.find((s) => s.method === 'GET' && s.url.startsWith('/rpc/cq1/quote'))
  assert.ok(get, 'the REST route was asked')
  assert.deepEqual([...new URL(get.url, 'http://x').searchParams.keys()].sort(), ['amount_in', 'dst_mint', 'slippage_bps', 'src_mint'])
  assert.doesNotMatch(get.url, /api[-_]?key|c_serv_/i)
  assert.ok(get.headers['x-api-key'])
  const both = await run(['quote', 'a', 'b', '1', '--rest', '--dex', 'r-amm'], ENV)
  assert.equal(both.status, 2)
})

test('stream tail --tx-exclude alone says it is a heavy stream; ws tail block refuses --commitment processed', async (t) => {
  const run = runner(await closedUrl(), home())
  const heavy = await run(['stream', 'tail', '--tx-exclude', 'Vote111111111111111111111111111111111111111'], ENV, undefined, 20_000)
  assert.notEqual(heavy.status, 0)
  assert.match(heavy.stderr, /note: --tx-exclude alone is every other transaction, a heavy stream/)
  const ws = new FakeSocket('notify')
  const url = await ws.start()
  t.after(() => ws.stop())
  const processed = await run(['ws', 'tail', 'block', '--commitment', 'processed', '--count', '1', '--endpoint', url], ENV, undefined, 15_000)
  assert.equal(processed.status, 2, processed.stderr)
  assert.match(processed.stderr, /blockSubscribe takes --commitment confirmed or finalized/)
  assert.equal(ws.seen.length, 0)
  const confirmed = await run(['ws', 'tail', 'block', '--commitment', 'confirmed', '--count', '1', '--endpoint', url], ENV, undefined, 15_000)
  assert.equal(confirmed.status, 0, confirmed.stderr)
  assert.deepEqual(ws.seen.map((s) => s.method), ['blockSubscribe'])
  assert.equal(((ws.seen[0]?.params as unknown[])[1] as { commitment?: string }).commitment, 'confirmed')
})

test('plain output cuts no table cell, pads no column past 100, keeps a column that holds objects (err), and gives each list item under a key one bullet', async () => {
  const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYVCJjBRah7iCGHG3mjmpCCBzJ7eChxbtESf9UcJiKcLyH7rJg3wHq'
  assert.equal(SIG.length, 88)
  const owner = '11111111111111111111111111111111'
  const answers: Record<string, unknown> = {
    getHealth: 'ok',
    getLatestBlockhash: { context: { slot: 381250119 }, value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 450473151 } },
    getSignaturesForAddress: [
      { signature: SIG.slice(0, 87) + 'a', slot: 381250119, err: null, memo: null, blockTime: 1795000000, confirmationStatus: 'finalized' },
      { signature: SIG, slot: 381250101, err: { InstructionError: [0, { Custom: 6001 }] }, memo: null, blockTime: 1794999990, confirmationStatus: 'finalized' },
      { signature: SIG.slice(0, 87) + 'b', slot: 381250099, err: { InstructionError: [1, { BorshIoError: 'Unexpected length of input '.repeat(12) }] }, memo: null, blockTime: 1794999989, confirmationStatus: 'finalized' },
    ],
    getMultipleAccounts: { context: { slot: 381250119 }, value: [{ lamports: 1, owner, space: 0 }, null, { lamports: 2, owner, space: 0 }] },
  }
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const b = JSON.parse(String(init?.body)) as { id: number; method: string }
    return Response.json({ jsonrpc: '2.0', id: b.id, result: answers[b.method] })
  }
  const plain = async (args: string[]): Promise<string> => {
    let out = ''
    assert.equal(await main(args, { stdout: (s) => void (out += s), stderr: () => undefined, env: { CARBIUM_KEY: SERVICE, CARBIUM_CONFIG_DIR: home() }, fetch }), 0)
    return out
  }
  const checks = await plain(['test'])
  assert.match(checks, /^getLatestBlockhash +slot 381250119, valid until block height 450473151 +\d+$/m, checks)
  const sigs = await plain(['rpc', 'getSignaturesForAddress', 'Addr'])
  assert.match(sigs, /^signature +slot +err +blockTime +confirmationStatus$/m, sigs)
  assert.match(sigs, new RegExp(`^${SIG} +381250101 +\\{"InstructionError":\\[0,\\{"Custom":6001\\}\\]\\} +1794999990 +finalized$`, 'm'), sigs)
  assert.deepEqual(sigs.split('\n').filter((l) => l.length > 250).map((l) => l.slice(0, 88)), [SIG.slice(0, 87) + 'b'], `only the row with the long cell runs past its column:\n${sigs}`)
  const accounts = await plain(['rpc', 'getMultipleAccounts', '["A","B","C"]'])
  assert.deepEqual(accounts.split('\n').filter((l) => /^ *- /.test(l)), ['  - lamports: 1', '  - null', '  - lamports: 2'], accounts)
  assert.equal(accounts.split('\n').filter((l) => l === `    owner: ${owner}`).length, 2, accounts)
})

test('getProgramAccounts goes as written (no dataSlice added); getMultipleAccounts over 100 keys needs --confirm-cost', async (t) => {
  const { door: d, run } = await door(t)
  assert.equal((await run(['rpc', 'getProgramAccounts', 'p', '{"filters":[{"dataSize":165}]}'], ENV)).status, 0)
  assert.deepEqual(rpcCalls(d).at(-1)?.params, ['p', { filters: [{ dataSize: 165 }] }])
  const nofilter = await run(['rpc', 'getProgramAccounts', 'p'], ENV)
  assert.equal(nofilter.status, 2)
  assert.match(nofilter.stderr, /no filters reads a whole program/)
  const keys = (n: number): string => JSON.stringify([Array.from({ length: n }, (_, i) => `Acc${i}`)])
  const over = await run(['rpc', 'getMultipleAccounts', '--params-json', keys(101)], ENV)
  assert.equal(over.status, 2, over.stderr)
  assert.match(over.stderr, /getMultipleAccounts of 101 keys costs 1010 credits \(10 per key\)/)
  assert.equal((await run(['rpc', 'getMultipleAccounts', '--params-json', keys(100)], ENV)).status, 0)
  assert.equal((await run(['rpc', 'getMultipleAccounts', '--params-json', keys(101), '--confirm-cost'], ENV)).status, 0)
  assert.deepEqual(rpcCalls(d).filter((c) => c.method === 'getMultipleAccounts').map((c) => (c.params[0] as unknown[]).length), [100, 101])
})

test('account API alignment: the das scope and cap class, one limit at a time, and no Terms prompt when no Terms are asked', async (t) => {
  const { door: d, run } = await door(t)
  const made = await run(['keys', 'create', '--scope', 'rpc,das', '--allow-writes', '--json'], ENV)
  assert.equal(made.status, 0, made.stderr)
  assert.deepEqual(bodies(d, 'POST', '/v1/keys')[0]?.['scope'], ['rpc', 'das'])
  assert.equal((await run(['keys', 'scope', '1', 'das', '--allow-writes'], ENV)).status, 0)
  assert.deepEqual(bodies(d, 'PATCH', '/v1/keys/1/scope')[0]?.['scope'], ['das'])
  const help = await run(['keys', 'create', '--help'])
  assert.match(help.stdout, /rpc, ws, grpc, quote, das/)
  assert.doesNotMatch(help.stdout, /default rpc/)
  assert.match((await run(['keys', 'caps', '--help'])).stdout, /gpa, das\)/)
  assert.equal((await run(['keys', 'limits', '1', '--max-inflight', '0', '--allow-writes'], ENV)).status, 0)
  assert.equal((await run(['keys', 'limits', '1', '--max-connections', '3', '--allow-writes'], ENV)).status, 0)
  assert.deepEqual(bodies(d, 'PATCH', '/v1/keys/1/limits'), [{ max_inflight: 0 }, { max_connections: 3 }])
  const neither = await run(['keys', 'limits', '1', '--allow-writes'], ENV)
  assert.equal(neither.status, 2)
  assert.match(neither.stderr, /give --max-connections, --max-inflight or both/)
  const { door: d2, run: run2 } = await door(t, { emptyTerms: true })
  const login = await run2(['login', '--email', 'a@b.c'], {}, '123456\n')
  assert.equal(login.status, 0, login.stderr)
  assert.doesNotMatch(login.stderr, /Terms/)
  assert.equal(bodies(d2, 'POST', '/v1/login/pin')[0]?.['terms_version'], '')
  assert.equal(bodies(d2, 'POST', '/v1/login/pin/verify')[0]?.['terms_version'], '')
})

test('wallet sign-in takes a base58 signature 88 characters long (it was read as base64 and refused); base64 still works', async (t) => {
  const { door: d, run } = await door(t)
  const w = wallet88()
  t.diagnostic(`a base58 signature of 88 characters after ${w.tries} key pair(s)`)
  const r = await run(['login', '--wallet', w.pubkey, '--json'], {}, w.signature + '\n')
  assert.equal(r.status, 0, r.stderr)
  noKey(r, 'login --wallet')
  assert.ok(r.stdout.includes(WALLET_MESSAGE), 'the message to sign is on stdout')
  const verify = bodies(d, 'POST', '/v1/auth/wallet').filter((b) => b['step'] === 'verify')
  assert.deepEqual(verify, [{ step: 'verify', wallet: w.pubkey, nonce_token: 'nt-1', signature: w.signature }])
  const b64 = w.raw.toString('base64')
  assert.ok(b64.length === 88 && b64.endsWith('=='))
  assert.equal((await run(['login', '--wallet', w.pubkey], {}, b64 + '\n')).status, 0)
})

test('every command path runs against the local servers: one fixture each, the planted keys never print, nothing sends', async (t) => {
  // known positives: both checks fire on a planted leak and a planted send
  assert.throws(() => noKey({ stdout: `x ${SERVICE}`, stderr: '' }, 'planted'))
  assert.throws(() => noSend([{ url: '/rpc', body: JSON.stringify([{ method: 'getSlot' }, { method: 'sendTransaction' }]) }]))
  assert.throws(() => noSend([{ url: '/dca/send', body: '{}' }]))
  await main(['--help'], { stdout: () => undefined, stderr: () => undefined, env: {} })
  const cmds = allCommands()
  const d = new CliDoor({ serviceKey: SERVICE, accountKey: ACCOUNT, access: 'full' })
  const base = await d.start()
  t.after(() => d.stop())
  const ws = new FakeSocket('notify')
  const wsUrl = await ws.start()
  t.after(() => ws.stop())
  const w = wallet88()
  interface Fixture { args?: string[]; input?: string; status?: number | 'nonzero'; check?: (r: Run) => void }
  const tail = (...a: string[]): Fixture => ({ args: [...a, '--endpoint', wsUrl] })
  const nonzero = (...a: string[]): Fixture => ({ args: a, status: 'nonzero' })
  const WALK: Record<string, Fixture[]> = {
    'config list': [{}], 'config get': [{ args: ['endpoint'] }], 'config set': [{ args: ['streamUrl', 'https://stream.example.test:9443'] }], 'config reset': [{ args: ['endpoint'] }, { args: ['--all', '-y'] }], 'config profiles': [{}], 'config use': [{ args: ['other'] }],
    completion: [{ args: ['bash'] }, { args: ['zsh'] }, { args: ['fish'] }], endpoints: [{}], doctor: [{}],
    login: [
      { args: ['--key'], input: ACCOUNT + '\n' },
      { args: ['--email', 'a@b.c', '--accept-terms'], input: '123456\n' },
      { args: ['--wallet', w.pubkey], input: w.signature + '\n', check: () => assert.ok(bodies(d, 'POST', '/v1/auth/wallet').some((b) => b['signature'] === w.signature)) },
    ],
    logout: [{}], whoami: [{}, { args: ['--activity'] }], 'keys save': [{ args: ['main'], input: SERVICE + '\n' }],
    rpc: [...['getSlot', 'getHealth', 'getVersion', 'getLatestBlockhash', 'getBlock 7', 'getTransaction sig', 'getSignaturesForAddress a', 'getProgramAccounts p --confirm-cost', 'getEpochInfo', 'getVoteAccounts', 'getClusterNodes', 'getAccountInfo 11111111111111111111111111111111'].map((m) => ({ args: m.split(' ') })), { args: ['getBalance', 'x'], status: 1, check: (r) => assert.match(r.stderr, /Invalid param/) }],
    'rpc list': [{}], das: [{ args: ['getAsset', 'id=x'] }, { args: ['getTokenAccounts', 'owner=o', 'limit=5'] }], 'das list': [{}],
    quote: [{ args: ['a', 'b', '1000'] }, { args: ['a', 'b', '1000', '--rest'] }], 'swap build': [{ args: ['q1', 'w'] }], prices: [{ args: ['a', 'b'] }], health: [{}], test: [{}],
    'ws tail': [tail('slot', '--count', '2'), tail('root', '--count', '1'), tail('slotsUpdates', '--count', '1'), tail('account', 'Acc1', '--count', '1'), tail('program', 'Prog1', '--count', '1'), tail('logs', 'all', '--count', '1'), tail('signature', 'Sig1'), tail('block', 'all', '--count', '1', '--commitment', 'finalized')],
    'stream tail': [nonzero('--slots', '--count', '1')], 'stream slot': [nonzero()], 'stream block-height': [nonzero()], 'stream latest-blockhash': [nonzero()], 'stream blockhash-valid': [nonzero('h')], 'stream version': [nonzero()], 'stream ping': [nonzero('1')], 'stream replay-info': [nonzero()],
    'keys list': [{}], 'keys create': [{ args: ['--name', 'x'] }], 'keys rotate': [{ args: ['42'] }], 'keys revoke': [{ args: ['42'] }], 'keys delete': [{ args: ['42'] }], 'keys rename': [{ args: ['1', 'n'] }], 'keys scope': [{ args: ['1', 'rpc,das'] }], 'keys caps': [{ args: ['1'] }, { args: ['1', '--set', 'das=5'] }], 'keys allowlist': [{ args: ['1'] }, { args: ['1', '--add', '203.0.113.7'] }], 'keys limits': [{ args: ['1', '--max-inflight', '0'] }],
    'webhooks list': [{}], 'webhooks get': [{ args: ['3'] }], 'webhooks deliveries': [{ args: ['3'] }], 'webhooks create': [{ args: ['--key-id', '1', '--url', 'https://h.test/x', '--address', 'a', '--secret-file', '{home}/wh.secret'] }], 'webhooks update': [{ args: ['3', '--name', 'n'] }], 'webhooks pause': [{ args: ['3'] }], 'webhooks resume': [{ args: ['3'] }], 'webhooks test': [{ args: ['3'] }], 'webhooks rotate': [{ args: ['3', '--secret-file', '{home}/rot.secret'] }], 'webhooks delete': [{ args: ['3'] }],
    usage: [{}, { args: ['--daily'] }, { args: ['--hourly'] }, { args: ['--latency'] }, { args: ['--load'] }], balance: [{}], account: [{}], 'account invoices': [{}], 'account payments': [{}], 'account crypto-intent': [{ args: ['5'] }], modules: [{}], 'modules enable': [{ args: ['quote'] }], plans: [{}],
    'dca quote': [{ args: ['a', 'b', '1'] }], 'dca positions': [{ args: ['o'] }], 'dca history': [{ args: ['o'] }], 'dca position': [{ args: ['p'] }], 'dca health': [{}],
    'dca build open': [{ args: ['--owner', 'o', '--in', 'a', '--out', 'b', '--cycles', '2', '--total', '10', '--frequency', 'daily'] }], 'dca build update': [{ args: ['--owner', 'o', '--position', 'p', '--pause'] }], 'dca build withdraw': [{ args: ['--owner', 'o', '--position', 'p', '--amount', '0'] }], 'dca build close': [{ args: ['--owner', 'o', '--position', 'p'] }],
    'tokens lookup': [{ args: ['m'] }], 'tokens search': [{ args: ['sol', '--no-token22'] }], 'tokens batch': [{ args: ['a', 'b'] }], 'tokens image': [{ args: ['m'] }],
  }
  const paths = cmds.map((c) => c.path.join(' '))
  assert.deepEqual(paths.filter((p) => !WALK[p]?.length), [], 'every command path has a fixture')
  assert.deepEqual(Object.keys(WALK).filter((p) => !paths.includes(p)), [], 'every fixture names a command path')
  let n = 0
  for (const c of cmds) {
    for (const f of WALK[c.path.join(' ')] ?? []) {
      const dir = home()
      const writes = c.access === 'write' || c.access === 'destructive' ? ['--allow-writes', '-y'] : []
      const args = [...c.path, ...(f.args ?? []).map((a) => a.replace('{home}', dir)), ...writes]
      const r = await runner(base, dir)(args, ENV, f.input, 20_000)
      const label = args.join(' ')
      noKey(r, label)
      if (r.killed) t.diagnostic(`${label}: killed at the 20 s timeout`)
      if (f.status === 'nonzero') assert.notEqual(r.status, 0, `${label} exited 0`)
      else assert.equal(r.status, f.status ?? 0, `${label} exited ${r.status}: ${r.stderr}`)
      f.check?.(r)
      n++
    }
  }
  t.diagnostic(`${n} fixtures over ${paths.length} command paths, ${d.seen.length} door requests, ${ws.seen.length} socket messages`)
  noSend(d.seen)
  assert.ok(!ws.seen.some((s) => /send/i.test(s.method)))
  assert.ok(d.seen.some((s) => s.url === '/v1/keys/42/revoke') && d.seen.some((s) => s.method === 'DELETE' && s.url === '/v1/webhooks/3'), 'the destructive fixtures reached the door')
  assert.ok(ws.seen.some((s) => s.method === 'blockSubscribe'), 'the ws fixtures reached the socket server')
})

test('writes are off by default, refused with a read-only key, and go through with --allow-writes and a full key; raw keys land in the 0600 file only', async (t) => {
  const { door: readDoor, run, dir } = await door(t, { access: 'read' })
  const env = { CARBIUM_ACCOUNT_KEY: ACCOUNT }
  const off = await run(['keys', 'create', '--name', 'x'], env)
  assert.equal(off.status, 3)
  assert.match(off.stderr, /writes are off/)
  assert.equal(readDoor.seen.length, 0, 'no request before the local refusal')
  const ro = await run(['keys', 'create', '--name', 'x', '--allow-writes'], env)
  assert.equal(ro.status, 3)
  assert.match(ro.stderr, /read-only/)
  assert.deepEqual(readDoor.seen.map((s) => `${s.method} ${s.url}`), ['GET /v1/api-key'])
  const fullDoor = new CliDoor({ serviceKey: SERVICE, accountKey: ACCOUNT, access: 'full' })
  const run2 = runner(await fullDoor.start(), dir)
  t.after(() => fullDoor.stop())
  const made = await run2(['keys', 'create', '--name', 'x', '--allow-writes', '--json'], env)
  assert.equal(made.status, 0, made.stderr)
  noKey(made, 'keys create')
  assert.ok(fullDoor.seen.some((s) => s.method === 'POST' && s.url === '/v1/keys'))
  const out = JSON.parse(made.stdout) as { keyId: number; savedAs: string }
  assert.equal(out.keyId, 42)
  const file = join(dir, 'cfg', 'carbium', 'credentials.json')
  assert.ok(existsSync(file))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.match(readFileSync(file, 'utf8'), new RegExp('c_serv_' + 'NEWKEY'))
  const destructive = await run2(['keys', 'revoke', '42', '--allow-writes'], env)
  assert.equal(destructive.status, 5, 'no terminal and no -y: confirmation needed')
  assert.equal(fullDoor.seen.filter((s) => s.url.endsWith('/revoke')).length, 0)
  const yes = await run2(['keys', 'revoke', '42', '--allow-writes', '-y'], env)
  assert.equal(yes.status, 0, yes.stderr)
  assert.equal(fullDoor.seen.filter((s) => s.url.endsWith('/revoke')).length, 1)
  const wh = await run2(['webhooks', 'create', '--key-id', '1', '--url', 'https://h.test/x', '--address', 'a', '--secret-file', join(dir, 'wh.secret'), '--allow-writes'], env)
  assert.equal(wh.status, 0, wh.stderr)
  noKey(wh, 'webhooks create')
  assert.match(readFileSync(join(dir, 'wh.secret'), 'utf8'), /^whsec_SECRET/)
  assert.equal(statSync(join(dir, 'wh.secret')).mode & 0o777, 0o600)
})

test('login --key from stdin stores the key, whoami works, logout forgets it; the stored key is never printed', async (t) => {
  const { door: d, run } = await door(t)
  const login = await run(['login', '--key'], {}, ACCOUNT + '\n')
  assert.equal(login.status, 0, login.stderr)
  noKey(login, 'login')
  const who = await run(['whoami', '--json'])
  assert.equal(who.status, 0, who.stderr)
  noKey(who, 'whoami')
  assert.equal((JSON.parse(who.stdout) as { key: { access: string } }).key.access, 'full')
  assert.equal((await run(['config', 'list'])).status, 0)
  noKey(await run(['config', 'list']), 'config list')
  const save = await run(['keys', 'save', 'main'], {}, SERVICE + '\n')
  assert.equal(save.status, 0, save.stderr)
  const slot = await run(['rpc', 'getSlot'])
  assert.equal(slot.status, 0, slot.stderr)
  assert.equal(d.seen.at(-1)?.headers['x-api-key'], SERVICE)
  const out = await run(['logout'])
  assert.equal(out.status, 0)
  assert.equal((await run(['rpc', 'getSlot'])).status, 3)
})

test('login --email: terms, proof of work, PIN, a minted read key and the revealed service key, all stored', async (t) => {
  const { door: d, run, dir } = await door(t)
  const r = await run(['login', '--email', 'a@b.c', '--accept-terms', '--json'], {}, '123456\n')
  assert.equal(r.status, 0, r.stderr)
  noKey(r, 'login --email')
  const paths = d.seen.map((s) => `${s.method} ${s.url}`)
  assert.deepEqual(paths.slice(0, 4), ['GET /v1/terms', 'GET /v1/signup/challenge', 'POST /v1/login/pin', 'POST /v1/login/pin/verify'])
  assert.ok(paths.includes('POST /v1/account/api-keys') && paths.includes('GET /v1/keys') && paths.includes('POST /v1/keys/1/secret'))
  const pin = JSON.parse(d.seen[2]!.body) as { pow: { challenge: string; nonce: number }; terms_version: string }
  assert.equal(pin.pow.challenge, 'chal')
  assert.equal(typeof pin.pow.nonce, 'number')
  assert.equal(pin.terms_version, 'v1')
  const creds = JSON.parse(readFileSync(join(dir, 'cfg', 'carbium', 'credentials.json'), 'utf8')) as { profiles: { default: { accountKey: { value: string; access: string }; serviceKeys: Record<string, { value: string }>; writes: boolean } } }
  assert.equal(creds.profiles.default.accountKey.value, 'c_acct_' + 'MINTED0000000000000000')
  assert.equal(creds.profiles.default.accountKey.access, 'read')
  assert.equal(creds.profiles.default.serviceKeys['default']?.value, 'c_serv_' + 'REVEALED00000000000000')
  assert.equal(creds.profiles.default.writes, false)
})

test('--version is the package.json version, so a binary prints what npm ships', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  let out = ''
  assert.equal(await main(['--version'], { stdout: (s) => (out += s), stderr: () => undefined, env: { CARBIUM_CONFIG_DIR: home() } }), 0)
  assert.equal(out.trim(), pkg.version)
})

test('a standalone binary says Carbon Stream needs the npm package, exit 2, before any key check or import', async () => {
  const g = globalThis as { Bun?: unknown }
  g.Bun = { isStandaloneExecutable: true }
  try {
    for (const args of [['stream', 'slot'], ['stream', 'ping'], ['stream', 'tail', '--slots']]) {
      let err = ''
      const code = await main([...args, '--stream-url', CLOSED], { stdout: () => undefined, stderr: (s) => (err += s), env: { CARBIUM_KEY: SERVICE, CARBIUM_CONFIG_DIR: home() } })
      assert.equal(code, 2, `${args.join(' ')}: ${err}`)
      assert.match(err, /Carbon Stream is not in the standalone binary/)
      assert.match(err, /npm install -g carbium @triton-one\/yellowstone-grpc/)
      noKey({ stdout: '', stderr: err }, args.join(' '))
    }
  } finally {
    delete g.Bun
  }
})

test('Ctrl-C at a hidden prompt exits 130 and lets go of stdin (it stayed flowing and held the process open)', async () => {
  const { PassThrough } = await import('node:stream')
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (_mode: boolean): void => undefined })
  let err = ''
  const done = main(['keys', 'save', 'k'], { stdout: () => undefined, stderr: (s) => (err += s), env: { CARBIUM_CONFIG_DIR: home() }, stdin })
  for (let i = 0; i < 400 && !err.includes('not shown'); i++) await new Promise((r) => setTimeout(r, 5))
  assert.match(err, /not shown/)
  stdin.write('\u0003')
  assert.equal(await done, 130)
  assert.equal(stdin.isPaused(), true)
})
