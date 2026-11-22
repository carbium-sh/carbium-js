#!/bin/sh
# Inside a plain node image: install the packed MCP server with the packed SDK beside it, drive it over stdio with a
# JSON-RPC initialize, tools/list and one keyless tools/call, with a planted key in the environment that must never show.
set -eu
cd "$(mktemp -d)"
echo "node $(node -v) npm $(npm -v)"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error /pkg/*.tgz
export PATH="$PWD/node_modules/.bin:$PATH"
echo "--- tarball contents"
tar -tzf /pkg/carbium-mcp-0.1.0.tgz | sort | tee files.txt | head -20
if grep -vE '^package/(dist/|server\.json$|README\.md$|LICENSE$|package\.json$)' files.txt; then echo "unexpected file in the tarball"; exit 1; fi
test "$(carbium-mcp --version)" = "0.1.0"
echo "--- stdio: initialize, tools/list, keyless token lookup (live), with a planted key in the environment"
cat > drive.mjs <<'JS'
import { spawn } from 'node:child_process'
const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'carbium_tokens', arguments: { action: 'lookup', mint: 'So11111111111111111111111111111111111111112' } } },
]
const child = spawn('carbium-mcp', [], { env: { ...process.env, CARBIUM_KEY: 'c_serv_' + 'PLANTEDSMOKE0000000000' }, stdio: ['pipe', 'pipe', 'pipe'] })
let out = '', err = ''
child.stdout.setEncoding('utf8').on('data', (d) => { out += d; if (/"id":3[,}]/.test(out)) child.stdin.end() })
child.stderr.setEncoding('utf8').on('data', (d) => (err += d))
child.stdin.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n')
setTimeout(() => { child.stdin.end(); setTimeout(() => child.kill(), 2000) }, 30000).unref()
child.on('close', () => {
  process.stderr.write(err)
  const lines = out.trim().split('\n').map((l) => JSON.parse(l))
  const tools = lines.find((l) => l.id === 2).result.tools.map((t) => t.name)
  const call = lines.find((l) => l.id === 3).result
  console.log('tools:', tools.join(', '))
  if (tools.length !== 6 || !tools.includes('carbium_rpc') || tools.includes('carbium_account_write')) { console.log('expected 6 tools with a service key'); process.exit(1) }
  if (call.isError || !JSON.stringify(call).includes('Wrapped SOL')) { console.log('lookup failed', JSON.stringify(call).slice(0, 300)); process.exit(1) }
  if ((out + err).includes('PLANTEDSMOKE')) { console.log('the key leaked'); process.exit(1) }
  console.log('keyless token lookup ok; no key in stdout or stderr')
})
JS
node drive.mjs
echo "smoke ok on node $(node -v)"
