// Proves a built @carbium/mcp image: labels match server.json, it runs as a non-root user on a read-only root
// filesystem, speaks MCP over stdio, lists only the keyless tools when no key is given, takes a key from `-e CARBIUM_KEY`
// without echoing it, and carries no key or CARBIUM_ variable in its config, history or layers. With CARBIUM_KEY set in
// the environment it also runs with that key: the same read-only tools and one getSlot answer, the key never shown.
// Usage: node image.mjs <image> <path/to/server.json> [--live]
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

const [image, serverJsonPath] = process.argv.slice(2)
const live = process.argv.includes('--live')
if (!image || !serverJsonPath) { console.error('usage: image.mjs <image> <server.json> [--live]'); process.exit(2) }
const server = JSON.parse(readFileSync(serverJsonPath, 'utf8'))
// A key-shaped value (the SDK's redaction pattern), an npm or GitHub token, or a CARBIUM_ assignment (config only).
const SECRET = /(c_serv_|c_acct_|whsec_)[A-Za-z0-9+/=_-]{5,}|npm_[A-Za-z0-9]{36}|gh[pousr]_[A-Za-z0-9]{36}/g
const KEY = new RegExp(`${SECRET.source}|CARBIUM_[A-Z_]+=\\S+`, 'g')
const SECRET_FILE = /(^|\/)(\.npmrc|\.yarnrc(\.yml)?|\.env(\.[^/]*)?|\.netrc|\.git-credentials)$/
const shown = (m) => m.replace(/^(c_serv_|c_acct_|whsec_|npm_|gh[pousr]_|CARBIUM_[A-Z_]+=)\S*/, '$1[redacted]')
const KEYLESS = ['carbium_docs_search', 'carbium_tokens', 'carbium_dca', 'carbium_rpc', 'carbium_swap']
let failed = 0
const check = (ok, what, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`) }
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20 })

// 1. Config: labels, user, environment.
const cfg = JSON.parse(docker('image', 'inspect', image))[0].Config
const L = cfg.Labels ?? {}
check(L['io.modelcontextprotocol.server.name'] === server.name, 'label io.modelcontextprotocol.server.name = server.json name', `${L['io.modelcontextprotocol.server.name']} vs ${server.name}`)
check(L['org.opencontainers.image.source'] === server.repository.url, 'label org.opencontainers.image.source = server.json repository.url')
check(L['org.opencontainers.image.licenses'] === 'MIT', 'label org.opencontainers.image.licenses = MIT')
const desc = L['org.opencontainers.image.description'] ?? ''
check(desc.length > 0 && desc.length <= 512, 'label org.opencontainers.image.description, 1-512 characters', `${desc.length}`)
const oci = server.packages.find((p) => p.registryType === 'oci')?.identifier ?? ''
check(oci === `ghcr.io/carbium-sh/carbium-mcp:${server.version}`, 'server.json names the image at its own version', oci)
check(!['', '0', 'root'].includes((cfg.User ?? '').split(':')[0]), 'config user is not root', cfg.User || '(empty)')
const envHits = (cfg.Env ?? []).filter((e) => e.startsWith('CARBIUM_') || e.match(KEY))
check(envHits.length === 0, 'no CARBIUM_ variable or key in the image environment', envHits.map((e) => shown(e)).join(', '))

// 2. History: every instruction that made the image.
const hist = docker('history', '--no-trunc', '--format', '{{.CreatedBy}}', image)
const histHits = [...new Set([...hist.matchAll(KEY)].map((m) => shown(m[0])))]
check(histHits.length === 0 && !hist.includes('CARBIUM_'), 'no key or CARBIUM_ variable in the image history', histHits.join(', '))

// 3. Layers: every byte of every layer, as saved.
const dir = mkdtempSync(join(tmpdir(), 'prove-image-'))
try {
  execFileSync('docker', ['save', '-o', join(dir, 'image.tar'), image])
  execFileSync('tar', ['-xf', join(dir, 'image.tar'), '-C', dir])
  const blob = (d) => join(dir, 'blobs', 'sha256', d.split(':')[1])
  let m = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).manifests[0]
  let manifest = JSON.parse(readFileSync(blob(m.digest), 'utf8'))
  if (manifest.manifests) manifest = JSON.parse(readFileSync(blob(manifest.manifests.find((x) => !x.platform || x.platform.os === 'linux').digest), 'utf8'))
  const layerHits = new Set()
  for (const layer of manifest.layers) {
    for (const row of execFileSync('tar', ['-tvf', blob(layer.digest)], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n')) {
      const [, , size, , , ...name] = row.trim().split(/\s+/) // a non-empty secrets-style file (npm ships an empty .npmrc)
      if (Number(size) > 0 && SECRET_FILE.test(name.join(' '))) layerHits.add(`file ${name.join(' ')}`)
    }
    const raw = createReadStream(blob(layer.digest))
    const stream = layer.mediaType.includes('gzip') ? raw.pipe(createGunzip()) : raw
    let carry = ''
    for await (const chunk of stream) {
      const s = carry + chunk.toString('latin1')
      for (const hit of s.matchAll(SECRET)) layerHits.add(shown(hit[0]))
      carry = s.slice(-128)
    }
  }
  check(layerHits.size === 0, `no key, token or secrets file in ${manifest.layers.length} layers`, [...layerHits].join(', '))
} finally { rmSync(dir, { recursive: true, force: true }) }

// 4. Run it as a client does, read-only and with no network, and drive the MCP handshake over stdio.
function drive(name, env, dockerArgs, calls = []) {
  return new Promise((resolve) => {
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prove-image', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ...calls,
    ]
    const last = msgs.at(-1).id
    const child = spawn('docker', ['run', '-i', '--rm', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--pids-limit=64', ...dockerArgs, image], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = '', uid = ''
    child.stdout.setEncoding('utf8').on('data', (d) => {
      out += d
      if (!uid && /"id":2[,}]/.test(out)) { try { uid = docker('top', name, '-o', 'pid,uid').trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/)[1]).join(',') } catch { uid = '?' } }
      if (new RegExp(`"id":${last}[,}]`).test(out)) child.stdin.end()
    })
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d))
    child.stdin.write(msgs.map((x) => JSON.stringify(x)).join('\n') + '\n')
    const t = setTimeout(() => { child.stdin.end(); setTimeout(() => child.kill(), 3000).unref() }, 30000)
    child.on('close', (code) => {
      clearTimeout(t)
      const lines = out.trim().split('\n').filter(Boolean)
      let parsed = []
      try { parsed = lines.map((l) => JSON.parse(l)) } catch { parsed = null }
      resolve({ code, out, err, uid, parsed })
    })
  })
}
const toolsOf = (r) => r.parsed?.find((l) => l.id === 2)?.result?.tools?.map((t) => t.name) ?? []
const readOnly = (r) => (r.parsed?.find((l) => l.id === 2)?.result?.tools ?? []).every((t) => t.annotations?.readOnlyHint === true)

const bare = await drive(`prove-mcp-${process.pid}-a`, {}, ['--network=none'])
check(bare.parsed !== null && bare.parsed.every((l) => l.jsonrpc === '2.0'), 'stdout carries only JSON-RPC lines (MCP over stdio)')
check(bare.parsed?.find((l) => l.id === 1)?.result?.serverInfo?.name !== undefined, 'initialize answered', JSON.stringify(bare.parsed?.find((l) => l.id === 1)?.result?.serverInfo ?? {}))
const t0 = toolsOf(bare)
console.log(`  tools with no key: ${t0.join(', ')}`)
check(t0.length === KEYLESS.length && KEYLESS.every((t) => t0.includes(t)), 'no key given: the five tools that work with no key are listed, carbium_das is not')
check(!t0.includes('carbium_account_write') && readOnly(bare), 'the write tool is not listed; every listed tool is read-only')
check(/service key none \(public methods only, 30 calls a minute per IP address\); account key none; writes off/.test(bare.err), 'startup line: no keys, the public limit, writes off', bare.err.trim().split('\n')[0].replace(/(c_serv_|c_acct_)[A-Za-z0-9]*/g, '$1[redacted]'))
check(bare.uid !== '' && bare.uid.split(',').every((u) => /^[1-9][0-9]*$/.test(u)), 'the server process runs as a non-root uid', bare.uid)

// 5. The client line `docker run -i --rm -e CARBIUM_KEY <image>`: the key arrives by name and never shows.
const planted = 'c_serv_' + 'PROVEIMAGE00000000000000'
const keyed = await drive(`prove-mcp-${process.pid}-b`, { CARBIUM_KEY: planted }, ['--network=none', '-e', 'CARBIUM_KEY'])
const t1 = toolsOf(keyed)
check(t1.includes('carbium_rpc') && t1.includes('carbium_swap') && t1.length === 6, '-e CARBIUM_KEY: the service tools are listed', t1.join(', '))
check(!(keyed.out + keyed.err).includes('PROVEIMAGE'), 'the passed key never appears on stdout or stderr')
check(readOnly(keyed) && !t1.includes('carbium_account_write'), 'with a key: every listed tool is read-only')

// 5b. The real capped key, when the caller gives one: the same tools, one getSlot answer with network, the key never shown.
if (process.env.CARBIUM_KEY) {
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'carbium_rpc', arguments: { method: 'getSlot', params: [] } } }
  const r = await drive(`prove-mcp-${process.pid}-k`, {}, ['-e', 'CARBIUM_KEY'], [call])
  const res = r.parsed?.find((l) => l.id === 3)?.result
  check(toolsOf(r).length === 6 && readOnly(r), 'the real key: six read-only tools', toolsOf(r).join(', '))
  check(res && !res.isError && /\d{6,}/.test(JSON.stringify(res.content)), 'the real key: getSlot answers a slot', res ? '' : r.err.slice(0, 200))
  check(!(r.out + r.err).includes(process.env.CARBIUM_KEY.slice(7)), 'the real key never appears on stdout or stderr')
}

// 6. Optional: one keyless live call through the read-only container (tokens.carbium.io).
if (live) {
  const call = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'carbium_tokens', arguments: { action: 'lookup', mint: 'So11111111111111111111111111111111111111112' } } }
  const r = await drive(`prove-mcp-${process.pid}-c`, {}, [], [call])
  const res = r.parsed?.find((l) => l.id === 3)?.result
  check(res && !res.isError && JSON.stringify(res).includes('Wrapped SOL'), 'live keyless token lookup works on a read-only root', res ? '' : r.err.slice(0, 200))
}
// 7. A client that quits sends SIGTERM to `docker run`; the container must end, not linger as PID 1.
{
  const name = `prove-mcp-${process.pid}-d`
  const child = spawn('docker', ['run', '-i', '--rm', '--read-only', '--network=none', '--name', name, image], { stdio: ['pipe', 'pipe', 'ignore'] })
  let out = ''
  child.stdout.setEncoding('utf8').on('data', (d) => (out += d))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prove-image', version: '0' } } }) + '\n')
  const running = () => docker('ps', '-q', '-f', `name=^${name}$`).trim() !== ''
  for (let i = 0; i < 100 && !out.includes('"id":1'); i++) await new Promise((r) => setTimeout(r, 100))
  child.kill('SIGTERM')
  const t0 = Date.now()
  while (running() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100))
  const lingered = running()
  if (lingered) { docker('rm', '-f', name); child.kill('SIGKILL') }
  check(!lingered, 'SIGTERM to docker run ends the container within 5 s', lingered ? 'still running; removed' : `${Date.now() - t0} ms`)
}
console.log(failed ? `${failed} check(s) failed` : 'image proven')
process.exit(failed ? 1 : 0)
