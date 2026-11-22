import { parseArgs, type ParseArgsConfig } from 'node:util'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createCarbium, CarbiumAccount, CarbiumDca, CarbiumTokens, isCarbiumError, redactSecrets, type Carbium, type SessionOptions, type AccountApiKey } from '@carbium/sdk'
import { Store, type Profile } from './config.ts'
import { VERSION } from './version.ts'

export interface Io {
  stdout(s: string): void
  stderr(s: string): void
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown }
  stdoutIsTTY?: boolean
  stderrIsTTY?: boolean
  signal?: AbortSignal
}

export interface OptSpec {
  type: 'string' | 'boolean'
  short?: string
  multiple?: boolean
  help: string
  /** The placeholder shown in help for a string option. */
  value?: string
}

export type Access = 'local' | 'keyless' | 'service' | 'account' | 'write' | 'destructive'

export interface Command {
  path: string[]
  summary: string
  /** Positionals as shown in help, for example "<id> [name]". */
  usage?: string
  options?: Record<string, OptSpec>
  access: Access
  /** The account scope a write needs, for example keys:write. */
  scope?: string
  run(ctx: Ctx): Promise<unknown>
}

export interface GlobalFlags {
  json: boolean
  yes: boolean
  quiet: boolean
  noInput: boolean
  allowWrites: boolean
  profile: string
  endpoint?: string
  dashboard?: string
  dcaUrl?: string
  tokensUrl?: string
  streamUrl?: string
  keyFile?: string
  serviceKey?: string
}

export const EXIT = { ok: 0, service: 1, usage: 2, auth: 3, limits: 4, confirm: 5, interrupted: 130 } as const

export class CliError extends Error {
  readonly code: number
  readonly hint: string | undefined
  constructor(code: number, message: string, hint?: string) {
    super(message)
    this.code = code
    this.hint = hint
  }
}

export type Args = Record<string, string | boolean | string[] | undefined>

export interface Ctx {
  io: Io
  flags: GlobalFlags
  args: Args
  positionals: string[]
  store: Store
  profile: Profile
  str(name: string): string | undefined
  bool(name: string): boolean
  list(name: string): string[]
  redact(s: string): string
  out(line: string): void
  err(line: string): void
  print(data: unknown): void
  prompt(question: string, hidden?: boolean): Promise<string>
  confirm(question: string): Promise<void>
  rememberSecret(secret: string | undefined): void
  serviceKey(): string
  accountKey(): string
  endpoint(): string
  streamUrl(): string
  dashboard(): string
  carbium(): Carbium
  account(): CarbiumAccount
  dca(): CarbiumDca
  tokens(): CarbiumTokens
  sessionOptions(): SessionOptions
  self(): Promise<AccountApiKey>
  requireWrite(scope: string | undefined): Promise<void>
}

const GLOBAL: Record<string, OptSpec> = {
  json: { type: 'boolean', help: 'print the service answer as JSON' },
  yes: { type: 'boolean', short: 'y', help: 'answer yes to confirmations (needed when not on a terminal)' },
  quiet: { type: 'boolean', short: 'q', help: 'no status lines on stderr' },
  'no-input': { type: 'boolean', help: 'never prompt' },
  'allow-writes': { type: 'boolean', help: 'allow write commands for this run (a profile set by login --full allows them already)' },
  profile: { type: 'string', value: '<name>', help: 'the stored profile for this run (default: the one carbium config use set, else "default")' },
  endpoint: { type: 'string', value: '<url>', help: 'services host (default https://services.carbium.sh)' },
  dashboard: { type: 'string', value: '<url>', help: 'account API host (default https://carbium.sh)' },
  'dca-url': { type: 'string', value: '<url>', help: 'DCA API base (default https://dex.carbium.io/api/dca)' },
  'tokens-url': { type: 'string', value: '<url>', help: 'token API host (default https://tokens.carbium.io)' },
  'stream-url': { type: 'string', value: '<url>', help: 'Carbon Stream host (default: the services host name on port 9443)' },
  'key-file': { type: 'string', value: '<path>', help: 'read the key from this file (a service or account key by its prefix); never pass a key on the command line' },
  'service-key': { type: 'string', value: '<name>', help: 'use this stored service key' },
  help: { type: 'boolean', short: 'h', help: 'show help' },
  version: { type: 'boolean', short: 'v', help: 'print the version' },
}

const SECRET_ARG = /(?:^|[^A-Za-z0-9])(c_serv_|c_acct_|whsec_)[A-Za-z0-9]/

export const ACCESS_HELP: Record<Access, string> = {
  local: 'local',
  keyless: 'no key',
  service: 'service key',
  account: 'account key',
  write: 'account key, writes on',
  destructive: 'account key, writes on, confirmation',
}

/** Parses a positional as JSON when it looks like JSON, else as a string; digits past 15 (an address of only digits) stay a string. */
export function value(s: string): unknown {
  if (/^\d{16,}$/.test(s)) return s
  if (/^(-?\d+(\.\d+)?|true|false|null|[[{"].*)$/s.test(s)) {
    try {
      return JSON.parse(s)
    } catch {
      return s
    }
  }
  return s
}

/** key=value pairs into an object; values parse as JSON when they look like it. */
export function pairs(items: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of items) {
    const i = item.indexOf('=')
    if (i <= 0) throw new CliError(EXIT.usage, `expected key=value, got ${item}`)
    out[item.slice(0, i)] = value(item.slice(i + 1))
  }
  return out
}

function human(data: unknown, indent = ''): string[] {
  if (data === undefined) return []
  if (data === null || typeof data !== 'object') return [`${indent}${String(data)}`]
  if (Array.isArray(data)) {
    if (data.length === 0) return [`${indent}(none)`]
    if (data.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) {
      const rows = data as Array<Record<string, unknown>>
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined))
      const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
      // a column pads to at most 100: a longer cell is printed whole and only its own row runs past the column
      const widths = cols.map((c) => Math.min(100, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))))
      const line = (vals: string[]): string => indent + vals.map((v, i) => v.padEnd(widths[i] as number)).join('  ').trimEnd()
      return [line(cols), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))]
    }
    return data.flatMap((v) => human(v, indent + '- ').map((l, i) => (i === 0 ? l : indent + '  ' + l.slice(indent.length + 2))))
  }
  const lines: string[] = []
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
      lines.push(`${indent}${k}:`)
      lines.push(...human(v, indent + '  '))
    } else lines.push(`${indent}${k}: ${v === null || typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  return lines
}

export function helpFor(commands: Command[], path: string[]): string {
  const prefix = path.join(' ')
  const exact = commands.find((c) => c.path.join(' ') === prefix)
  const children = commands.filter((c) => c.path.length > path.length && c.path.slice(0, path.length).join(' ') === prefix)
  const lines: string[] = []
  if (exact) {
    lines.push(`usage: carbium ${prefix}${exact.usage ? ' ' + exact.usage : ''} [options]`, '', exact.summary, `access: ${ACCESS_HELP[exact.access]}${exact.scope ? ` (${exact.scope})` : ''}`)
    if (exact.options && Object.keys(exact.options).length) {
      lines.push('', 'options:')
      for (const [name, o] of Object.entries(exact.options)) lines.push(`  --${name}${o.value ? ' ' + o.value : ''}${o.short ? `, -${o.short}` : ''}  ${o.help}`)
    }
  } else {
    lines.push(path.length ? `usage: carbium ${prefix} <command>` : 'usage: carbium <command> [options]', '')
    if (!path.length) lines.push('Carbium command line: Solana RPC and DAS by method name, quotes and unsigned swaps, WebSocket and Carbon Stream tails, keys, webhooks, usage, DCA and tokens. Nothing here signs or sends; keys never appear in output.', '')
  }
  if (children.length) {
    lines.push('commands:')
    const next = [...new Set(children.map((c) => c.path[path.length] as string))]
    for (const n of next) {
      const direct = commands.find((c) => c.path.join(' ') === [...path, n].join(' '))
      const count = children.filter((c) => c.path[path.length] === n && c.path.length > path.length + 1).length
      lines.push(`  ${n.padEnd(14)} ${direct ? direct.summary : `${count} commands`}`)
    }
  }
  if (!path.length) {
    lines.push('', 'global options:')
    for (const [name, o] of Object.entries(GLOBAL)) lines.push(`  --${name}${o.value ? ' ' + o.value : ''}${o.short ? `, -${o.short}` : ''}  ${o.help}`)
    lines.push('', 'exit codes: 0 ok, 1 service error, 2 usage, 3 no key or refused, 4 credits or rate limit, 5 confirmation needed, 130 interrupted')
  }
  return lines.join('\n')
}

function parseConfig(options: Record<string, OptSpec>): ParseArgsConfig['options'] {
  const out: NonNullable<ParseArgsConfig['options']> = {}
  for (const [name, o] of Object.entries(options)) out[name] = { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }
  return out
}

let registry: Command[] = []
/** The command table, filled by the command modules at import. */
export function register(cmds: Command[]): void {
  registry = [...registry, ...cmds]
}
export function allCommands(): Command[] {
  return registry
}

export async function main(argv: string[], ioIn: Partial<Io> = {}): Promise<number> {
  const io: Io = {
    stdout: ioIn.stdout ?? ((s) => void process.stdout.write(s)),
    stderr: ioIn.stderr ?? ((s) => void process.stderr.write(s)),
    env: ioIn.env ?? process.env,
    ...(ioIn.fetch ? { fetch: ioIn.fetch } : {}),
    stdin: ioIn.stdin ?? process.stdin,
    stdoutIsTTY: ioIn.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    stderrIsTTY: ioIn.stderrIsTTY ?? Boolean(process.stderr.isTTY),
    ...(ioIn.signal ? { signal: ioIn.signal } : {}),
  }
  await import('./commands/index.ts')
  const commands = allCommands()
  const secrets = new Set<string>()
  const redact = (s: string): string => {
    let out = s
    for (const k of secrets) if (k) out = out.split(k).join('[redacted]')
    return redactSecrets(out)
  }
  const err = (line: string): void => io.stderr(redact(line) + '\n')
  const out = (line: string): void => io.stdout(redact(line) + '\n')

  for (const a of argv) if (SECRET_ARG.test(a)) {
    err('carbium: a key or secret on the command line is refused (it would land in shell history and process lists); use --key-file, the environment or a stored profile')
    return EXIT.usage
  }

  let words: string[] = []
  let cmd: Command | undefined
  let parsed: ReturnType<typeof parseArgs>
  try {
    // the command: the longest path among the leading positionals, read past the global options; then the strict parse
    words = parseArgs({ args: argv, options: parseConfig(GLOBAL), allowPositionals: true, strict: false }).positionals
    for (let n = Math.min(words.length, 3); n > 0 && !cmd; n--) cmd = commands.find((c) => c.path.join(' ') === words.slice(0, n).join(' '))
    parsed = parseArgs({ args: argv, options: parseConfig({ ...GLOBAL, ...(cmd?.options ?? {}) }), allowPositionals: true, strict: true })
    if (cmd && parsed.positionals.slice(0, cmd.path.length).join(' ') !== cmd.path.join(' ')) throw new Error(`an option of carbium ${cmd.path.join(' ')} goes after the command name`)
  } catch (e) {
    err(`carbium: ${(e as Error).message}`)
    return EXIT.usage
  }
  const v = parsed.values as Args
  if (v['version']) {
    out(VERSION)
    return EXIT.ok
  }
  const positionals = parsed.positionals.slice(cmd ? cmd.path.length : 0)
  if (v['help'] || !cmd) {
    // the words that are a prefix of some command path; the first word past them is not a command there
    let n = 0
    while (n < words.length && commands.some((c) => c.path.length > n && c.path.slice(0, n + 1).join(' ') === words.slice(0, n + 1).join(' '))) n++
    const path = cmd ? cmd.path : words.slice(0, n)
    const text = helpFor(commands, path)
    if (!cmd && words.length > n) {
      err(n ? `carbium: "${words[n]}" is not a command of carbium ${path.join(' ')}\n` : `carbium: unknown command "${words.join(' ')}"\n`)
      io.stderr(text + '\n')
      return EXIT.usage
    }
    out(text)
    // help asked for is a success; a group named with no command is a usage error
    return v['help'] || cmd || !words.length ? EXIT.ok : EXIT.usage
  }

  const flags: GlobalFlags = {
    json: Boolean(v['json']),
    yes: Boolean(v['yes']),
    quiet: Boolean(v['quiet']),
    noInput: Boolean(v['no-input']),
    allowWrites: Boolean(v['allow-writes']),
    profile: typeof v['profile'] === 'string' ? v['profile'] : '',
    ...(typeof v['endpoint'] === 'string' ? { endpoint: v['endpoint'] } : {}),
    ...(typeof v['dashboard'] === 'string' ? { dashboard: v['dashboard'] } : {}),
    ...(typeof v['dca-url'] === 'string' ? { dcaUrl: v['dca-url'] } : {}),
    ...(typeof v['tokens-url'] === 'string' ? { tokensUrl: v['tokens-url'] } : {}),
    ...(typeof v['stream-url'] === 'string' ? { streamUrl: v['stream-url'] } : {}),
    ...(typeof v['key-file'] === 'string' ? { keyFile: v['key-file'] } : {}),
    ...(typeof v['service-key'] === 'string' ? { serviceKey: v['service-key'] } : {}),
  }
  const store = new Store(io.env, (l) => err(`carbium: ${l}`))
  flags.profile ||= store.profileName // --profile is for this run; only carbium config use changes the stored default
  const profile = store.profile(flags.profile)
  for (const s of store.secrets()) secrets.add(s)
  for (const name of ['CARBIUM_KEY', 'CARBIUM_ACCOUNT_KEY']) if (io.env[name]) secrets.add(io.env[name] as string)
  let fileKey: string | undefined
  if (flags.keyFile) {
    try {
      fileKey = readFileSync(flags.keyFile, 'utf8').trim()
    } catch (e) {
      err(`carbium: cannot read --key-file: ${(e as Error).message}`)
      return EXIT.usage
    }
    secrets.add(fileKey)
  }
  const fetchOpt = io.fetch ? { fetch: io.fetch } : {}
  let selfCache: Promise<AccountApiKey> | undefined

  const ctx: Ctx = {
    io,
    flags,
    args: v,
    positionals,
    store,
    profile,
    str: (n) => (typeof v[n] === 'string' ? (v[n] as string) : undefined),
    bool: (n) => Boolean(v[n]),
    list: (n) => (Array.isArray(v[n]) ? (v[n] as string[]) : typeof v[n] === 'string' ? [v[n] as string] : []),
    redact,
    out,
    err: (line) => (flags.quiet ? undefined : err(line)),
    print: (data) => {
      if (data === undefined) return
      if (flags.json) out(JSON.stringify(data, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2))
      else for (const line of human(data)) out(line)
    },
    prompt: (question, hidden = false) => prompt(io, question, hidden, flags.noInput),
    confirm: async (question) => {
      if (flags.yes) return
      if (flags.noInput || !io.stdin?.isTTY) throw new CliError(EXIT.confirm, `${question}: confirmation needed; pass -y when not on a terminal`)
      const a = await prompt(io, `${question} [y/N] `, false, false)
      if (!/^y(es)?$/i.test(a.trim())) throw new CliError(EXIT.confirm, 'not confirmed')
    },
    rememberSecret: (s) => {
      if (s) secrets.add(s)
    },
    serviceKey: () => {
      if (fileKey?.startsWith('c_serv_')) return fileKey
      const env = io.env['CARBIUM_KEY']
      if (env) return env
      const name = flags.serviceKey ?? profile.defaultServiceKey ?? Object.keys(profile.serviceKeys ?? {})[0]
      const k = name ? profile.serviceKeys?.[name] : undefined
      if (!k) throw new CliError(EXIT.auth, 'no service key', 'run carbium login (email or wallet), carbium keys create, or carbium keys save <name>; or set CARBIUM_KEY')
      return k.value
    },
    accountKey: () => {
      if (fileKey?.startsWith('c_acct_')) return fileKey
      const env = io.env['CARBIUM_ACCOUNT_KEY']
      if (env) return env
      if (profile.accountKey) return profile.accountKey.value
      throw new CliError(EXIT.auth, 'no account key', 'run carbium login --key, --email or --wallet; or set CARBIUM_ACCOUNT_KEY')
    },
    endpoint: () => flags.endpoint ?? profile.endpoint ?? 'https://services.carbium.sh',
    streamUrl: () => flags.streamUrl ?? profile.streamUrl ?? `https://${new URL(ctx.endpoint()).hostname}:9443`,
    dashboard: () => flags.dashboard ?? profile.dashboard ?? 'https://carbium.sh',
    carbium: () => createCarbium({ apiKey: ctx.serviceKey(), endpoint: ctx.endpoint(), ...fetchOpt }),
    account: () => new CarbiumAccount({ apiKey: ctx.accountKey(), baseUrl: ctx.dashboard(), ...fetchOpt }),
    dca: () => new CarbiumDca({ baseUrl: flags.dcaUrl ?? profile.dcaUrl ?? 'https://dex.carbium.io/api/dca', ...fetchOpt }),
    tokens: () => new CarbiumTokens({ baseUrl: flags.tokensUrl ?? profile.tokensUrl ?? 'https://tokens.carbium.io', ...fetchOpt }),
    sessionOptions: () => ({ baseUrl: ctx.dashboard(), ...fetchOpt }),
    self: () => (selfCache ??= ctx.account().self()),
    requireWrite: async (scope) => {
      if (!(profile.writes || flags.allowWrites)) throw new CliError(EXIT.auth, 'writes are off for this profile', 'sign in with carbium login --full, run carbium config set writes true, or pass --allow-writes')
      const me = await ctx.self()
      if (me.access !== 'full') throw new CliError(EXIT.auth, `this account key is read-only (access: ${me.access})`, 'account changes need a key with full access: carbium login --full, or a full key from the carbium.sh ACCOUNT page')
      if (scope && !me.scopes.includes(scope)) throw new CliError(EXIT.auth, `this account key lacks the ${scope} scope`)
    },
  }

  try {
    if (cmd.access === 'write' || cmd.access === 'destructive') await ctx.requireWrite(cmd.scope)
    const data = await cmd.run(ctx)
    ctx.print(data)
    return EXIT.ok
  } catch (e) {
    return report(e, ctx)
  }
}

function report(e: unknown, ctx: Ctx): number {
  if (e instanceof CliError) {
    ctx.io.stderr(ctx.redact(`carbium: ${e.message}${e.hint ? `\n  ${e.hint}` : ''}`) + '\n')
    return e.code
  }
  if (isCarbiumError(e)) {
    if (ctx.flags.json) ctx.io.stderr(ctx.redact(JSON.stringify({ error: e.toJSON() })) + '\n')
    else {
      const lines = [`carbium: ${e.kind} error${e.reason ? ` ${e.reason}` : e.code !== null ? ` ${e.code}` : ''}: ${e.message}`, `  retryable: ${e.retryable ? 'yes' : 'no'}${e.retryAfterMs ? `, after ${e.retryAfterMs} ms` : ''}${e.httpStatus ? `  http: ${e.httpStatus}` : ''}${e.requestId ? `  request id: ${e.requestId}` : ''}`]
      const hint = HINTS.find(([re]) => re.test(e.message))?.[1]
      if (hint) lines.push(`  what to do: ${hint}`)
      ctx.io.stderr(ctx.redact(lines.join('\n')) + '\n')
    }
    const stream = e.kind === 'stream' ? e.reason : undefined
    if (e.kind === 'auth' || stream === 'UNAUTHENTICATED' || stream === 'PERMISSION_DENIED') return EXIT.auth
    if (e.kind === 'credits' || e.kind === 'rate_limit' || stream === 'RESOURCE_EXHAUSTED') return EXIT.limits
    if (stream === 'TLS_ROOTS') return EXIT.usage // a setup problem on this machine, like a missing stream client
    return EXIT.service
  }
  if ((e as { name?: string }).name === 'AbortError') return EXIT.interrupted
  ctx.io.stderr(ctx.redact(`carbium: ${e instanceof Error ? e.message : String(e)}`) + '\n')
  return EXIT.service
}

const HINTS: ReadonlyArray<[RegExp, string]> = [
  [/unknown api key/i, 'send the full key: carbium login, or carbium keys save <name>'],
  [/not enabled for (grpc|websocket|rpc|quote)/i, 'add the scope to the key: carbium keys scope <id> rpc,ws,grpc,quote (needs writes on)'],
  [/not included in this tier/i, 'Carbon Stream needs DEV, BUSINESS or PRO; on FREE use carbium ws tail'],
  [/heavy streams are not included/i, 'use --accounts instead of --owners, or upgrade to BUSINESS'],
  [/credits exhausted/i, 'buy a plan or upgrade on carbium.sh; do not loop'],
  [/module not enabled/i, 'carbium modules enable quote --plan free (needs writes on), or the dashboard MODULES page'],
  [/read only/i, 'carbium login --full, or a full account key'],
  [/rate limit/i, 'wait the time shown, then try again with fewer calls'],
  [/this account was deleted|signup refused|registration cap/i, 'the sign-up was refused by the service; see the message'],
]

async function prompt(io: Io, question: string, hidden: boolean, noInput: boolean): Promise<string> {
  if (noInput) throw new CliError(EXIT.confirm, `${question}: input needed; prompts are off (--no-input)`)
  const stdin = io.stdin
  if (!stdin) throw new CliError(EXIT.confirm, 'no stdin')
  io.stderr(question)
  if (hidden && stdin.isTTY && stdin.setRawMode) {
    return new Promise((resolve, reject) => {
      let buf = ''
      stdin.setRawMode?.(true)
      stdin.resume()
      const onData = (chunk: Buffer | string): void => {
        for (const ch of String(chunk)) {
          if (ch === '\u0003') {
            stdin.setRawMode?.(false)
            stdin.off('data', onData)
            stdin.pause()
            reject(new CliError(EXIT.interrupted, 'interrupted'))
            return
          }
          if (ch === '\r' || ch === '\n') {
            stdin.setRawMode?.(false)
            stdin.off('data', onData)
            stdin.pause()
            io.stderr('\n')
            resolve(buf)
            return
          }
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
          else buf += ch
        }
      }
      stdin.on('data', onData)
    })
  }
  const rl = createInterface({ input: stdin, terminal: false })
  try {
    for await (const line of rl) return line
    return ''
  } finally {
    rl.close()
  }
}
