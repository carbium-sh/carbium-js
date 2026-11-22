#!/usr/bin/env node
// carbium-mcp: the Carbium MCP server over stdio. Keys come from the environment the MCP client sets; logs go to stderr only.
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { redactingTransport, Redactor } from './guard.ts'
import { createServer } from './tools.ts'
import { VERSION } from './version.ts'

const env = process.env
const apiKey = env['CARBIUM_KEY'] || undefined
const accountKey = env['CARBIUM_ACCOUNT_KEY'] || undefined
const allowWrites = env['CARBIUM_MCP_ALLOW_WRITES'] === '1'
const redactor = new Redactor()
redactor.add(apiKey)
redactor.add(accountKey)
const log = (line: string): void => void process.stderr.write(`carbium-mcp: ${redactor.text(line)}\n`)

if (apiKey && !/^c_serv_[A-Za-z0-9]+$/.test(apiKey)) {
  log('CARBIUM_KEY must be a full service key (c_serv_…); an account key (c_acct_…) goes in CARBIUM_ACCOUNT_KEY')
  process.exit(2)
}
if (accountKey && !/^c_acct_[A-Za-z0-9]+$/.test(accountKey)) {
  log('CARBIUM_ACCOUNT_KEY must be an account API key (c_acct_…)')
  process.exit(2)
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
}

const prefix = (k: string | undefined): string => (k ? k.slice(0, 11) : 'none')
log(`v${VERSION}; service key ${prefix(apiKey)}; account key ${prefix(accountKey)}; writes ${allowWrites ? 'on' : 'off'}`)

const options = {
  ...(apiKey ? { apiKey } : {}),
  ...(accountKey ? { accountKey } : {}),
  allowWrites,
  ...(env['CARBIUM_ENDPOINT'] ? { endpoint: env['CARBIUM_ENDPOINT'] } : {}),
  ...(env['CARBIUM_DASHBOARD_URL'] ? { dashboardUrl: env['CARBIUM_DASHBOARD_URL'] } : {}),
  ...(env['CARBIUM_DCA_URL'] ? { dcaUrl: env['CARBIUM_DCA_URL'] } : {}),
  ...(env['CARBIUM_TOKENS_URL'] ? { tokensUrl: env['CARBIUM_TOKENS_URL'] } : {}),
  ...(env['CARBIUM_DOCS_URLS'] ? { docsUrls: env['CARBIUM_DOCS_URLS'].split(',') } : {}),
}
// A container's PID 1 ignores SIGTERM unless it handles it: a client that quits would leave the container running.
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => process.exit(0))
serveStdio(() => createServer(options), { transport: redactingTransport(new StdioServerTransport(), redactor), onerror: (e) => log(`error: ${e.message}`) })
