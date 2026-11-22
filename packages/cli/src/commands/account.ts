import { CarbiumSession, type KeyScope, type MethodCap } from '@carbium/sdk'
import { KEY_PREFIX_LEN, reserveSecretFile } from '../config.ts'
import { CliError, EXIT, register, type Ctx } from '../main.ts'
import { storeServiceKey } from './login.ts'

const id = (ctx: Ctx, usage: string): number => {
  const n = Number(ctx.positionals[0])
  if (!Number.isInteger(n) || n <= 0) throw new CliError(EXIT.usage, usage)
  return n
}
const prefix = (p: string): string => p.slice(0, KEY_PREFIX_LEN)
const scopes = (s: string): KeyScope[] => {
  const list = s.split(',').map((x) => x.trim()).filter(Boolean) as KeyScope[]
  for (const x of list) if (!['rpc', 'ws', 'grpc', 'quote', 'das'].includes(x)) throw new CliError(EXIT.usage, `scope must be a comma list of rpc, ws, grpc, quote, das; got ${x}`)
  if (!list.length) throw new CliError(EXIT.usage, 'at least one scope')
  return list
}
const range = (ctx: Ctx): { from?: string; to?: string; key_id?: number } => ({ ...(ctx.str('from') ? { from: ctx.str('from') as string } : {}), ...(ctx.str('to') ? { to: ctx.str('to') as string } : {}), ...(ctx.str('key-id') ? { key_id: Number(ctx.str('key-id')) } : {}) })
/** The Authorization header from --auth-header-env, remembered as a secret; '' with --clear-auth-header. */
const authHeader = (ctx: Ctx): string | undefined => {
  const name = ctx.str('auth-header-env')
  if (name && ctx.bool('clear-auth-header')) throw new CliError(EXIT.usage, '--auth-header-env or --clear-auth-header, not both')
  if (ctx.bool('clear-auth-header')) return ''
  const auth = name ? ctx.io.env[name] : undefined
  if (name && !auth) throw new CliError(EXIT.usage, `${name} is not set`)
  ctx.rememberSecret(auth)
  return auth
}
/** --secret-file made before the service acts, so a bad path stops the run with nothing changed. */
export function reserve(path: string): ReturnType<typeof reserveSecretFile> {
  try {
    return reserveSecretFile(path)
  } catch (e) {
    throw new CliError(EXIT.usage, `cannot make --secret-file ${path}: ${(e as Error).message}`, 'name a new file in a folder that exists; it is never overwritten')
  }
}
/** The webhook call that returns a secret, with --secret-file made first: a bad path stops the run before the service acts. */
async function withSecretFile<T extends { secret: string }>(ctx: Ctx, path: string, webhookId: (r: T) => number, call: () => Promise<T>): Promise<T> {
  const file = reserve(path)
  let r: T
  try {
    r = await call()
  } catch (e) {
    file.discard()
    throw e
  }
  ctx.rememberSecret(r.secret)
  try {
    file.write(r.secret)
  } catch (e) {
    throw new CliError(EXIT.service, `webhook ${webhookId(r)}: its new secret could not be written to ${path} (${(e as Error).message}) and is not shown`, `make a new one: carbium webhooks rotate ${webhookId(r)} --secret-file <new path>`)
  }
  return r
}
const secretOpts = { 'save-as': { type: 'string' as const, value: '<name>', help: 'store the new key under this profile name (default key-<id>)' }, 'secret-file': { type: 'string' as const, value: '<path>', help: 'write the raw key to this new 0600 file instead of, or as well as, the profile' } }

register([
  // service keys
  { path: ['keys', 'list'], summary: 'the service keys: id, prefix, name, scope, status, caps (never a value)', access: 'account', run: async (ctx) => (await ctx.account().keys.list()).map((k) => ({ ...k, prefix: k.prefix === null ? null : prefix(k.prefix) })) },
  {
    path: ['keys', 'create'], summary: 'make a service key; the value is stored in the profile or a 0600 file, never printed', access: 'write', scope: 'keys:write',
    options: { name: { type: 'string', value: '<name>', help: 'a label, up to 48 characters' }, scope: { type: 'string', value: '<list>', help: 'a comma list of rpc, ws, grpc, quote, das (left out, the service picks)' }, ...secretOpts },
    run: async (ctx) => {
      const scope = ctx.str('scope') ? scopes(ctx.str('scope') as string) : undefined
      const path = ctx.str('secret-file')
      const file = path ? reserve(path) : undefined
      let made
      try {
        made = await ctx.account().keys.create({ ...(ctx.str('name') ? { name: ctx.str('name') as string } : {}), ...(scope ? { scope } : {}) })
      } catch (e) {
        file?.discard()
        throw e
      }
      return { keyId: made.key_id, name: made.name, ...storeServiceKey(ctx, made.raw_key, made.key_id, scope, ctx.str('save-as'), path && file ? { path, file } : undefined) }
    },
  },
  {
    path: ['keys', 'rotate'], summary: 'a new value for a service key (the old one stops working); stored, never printed', usage: '<id>', access: 'destructive', scope: 'keys:write', options: secretOpts,
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys rotate <id>')
      await ctx.confirm(`rotate key ${keyId}? the current value stops working`)
      const path = ctx.str('secret-file')
      const file = path ? reserve(path) : undefined
      let r
      try {
        r = await ctx.account().keys.rotate(keyId)
      } catch (e) {
        file?.discard()
        throw e
      }
      const stored = Object.entries(ctx.profile.serviceKeys ?? {}).find(([, k]) => k.keyId === keyId)?.[0]
      return { keyId, ...storeServiceKey(ctx, r.raw_key, keyId, undefined, ctx.str('save-as') ?? stored, path && file ? { path, file } : undefined) }
    },
  },
  {
    path: ['keys', 'revoke'], summary: 'revoke a service key', usage: '<id>', access: 'destructive', scope: 'keys:write',
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys revoke <id>')
      await ctx.confirm(`revoke key ${keyId}?`)
      const r = await ctx.account().keys.revoke(keyId)
      for (const [name, k] of Object.entries(ctx.profile.serviceKeys ?? {})) if (k.keyId === keyId) { delete ctx.profile.serviceKeys?.[name]; if (ctx.profile.defaultServiceKey === name) delete ctx.profile.defaultServiceKey }
      ctx.store.save()
      return r
    },
  },
  {
    path: ['keys', 'delete'], summary: 'delete a service key record', usage: '<id>', access: 'destructive', scope: 'keys:write',
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys delete <id>')
      await ctx.confirm(`delete key ${keyId}?`)
      return ctx.account().keys.delete(keyId)
    },
  },
  { path: ['keys', 'rename'], summary: 'rename a service key ("" clears the name)', usage: '<id> <name>', access: 'write', scope: 'keys:write', run: async (ctx) => ctx.account().keys.rename(id(ctx, 'usage: carbium keys rename <id> <name>'), ctx.positionals[1] ?? '') },
  { path: ['keys', 'scope'], summary: 'set the planes a key may call: rpc,ws,grpc,quote,das', usage: '<id> <scopes>', access: 'write', scope: 'keys:write', run: async (ctx) => ctx.account().keys.setScope(id(ctx, 'usage: carbium keys scope <id> rpc,ws,grpc,quote,das'), scopes(ctx.positionals[1] ?? '')) },
  {
    path: ['keys', 'caps'], summary: 'show or set per-method-class caps: --set class=rps or class=deny (o1_cached, bounded_read, bounded_slot, write_send, compute, bounded_disk, range, scan, gpa, das); --clear removes them', usage: '<id>', access: 'write', scope: 'keys:write',
    options: { set: { type: 'string', multiple: true, value: '<class=rps|deny>', help: 'a cap, repeatable; the whole list is replaced' }, clear: { type: 'boolean', help: 'remove every cap' } },
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys caps <id> [--set class=rps]... [--clear]')
      const sets = ctx.list('set')
      if (!sets.length && !ctx.bool('clear')) return (await ctx.account().keys.list()).find((k) => k.key_id === keyId)?.per_method_caps ?? []
      const caps: MethodCap[] = ctx.bool('clear') ? [] : sets.map((s) => {
        const [cls, v] = s.split('=')
        if (!cls || !v) throw new CliError(EXIT.usage, `--set takes class=rps or class=deny, got ${s}`)
        return v === 'deny' ? { method_class: cls as MethodCap['method_class'], allow: false } : { method_class: cls as MethodCap['method_class'], rps_ceiling: Number(v) }
      })
      return ctx.account().keys.setCaps(keyId, caps)
    },
  },
  {
    path: ['keys', 'allowlist'], summary: 'show or set the IP allowlist (up to 16 entries; the whole list is replaced)', usage: '<id>', access: 'write', scope: 'keys:write',
    options: { set: { type: 'string', value: '<ip,ip>', help: 'the new list, comma separated' }, add: { type: 'string', value: '<ip>', help: 'add one entry to the current list' }, remove: { type: 'string', value: '<ip>', help: 'remove one entry' }, clear: { type: 'boolean', help: 'remove every entry' } },
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys allowlist <id> [--set a,b | --add ip | --remove ip | --clear]')
      const current = (await ctx.account().keys.list()).find((k) => k.key_id === keyId)?.ip_allow ?? []
      let next: string[] | undefined
      if (ctx.bool('clear')) next = []
      else if (ctx.str('set') !== undefined) next = (ctx.str('set') as string).split(',').map((x) => x.trim()).filter(Boolean)
      else if (ctx.str('add')) next = [...new Set([...current, ctx.str('add') as string])]
      else if (ctx.str('remove')) next = current.filter((x) => x !== ctx.str('remove'))
      if (next === undefined) return { key_id: keyId, ip_allow: current }
      if (next.length > 16) throw new CliError(EXIT.usage, 'at most 16 allowlist entries')
      return ctx.account().keys.setAllowlist(keyId, next)
    },
  },
  {
    path: ['keys', 'limits'], summary: 'set the connection and in-flight limits of a key, 0 to 10000 each; 0 or a limit left out is the plan\'s own number (both are replaced together)', usage: '<id>', access: 'write', scope: 'keys:write',
    options: { 'max-connections': { type: 'string', value: '<n>', help: 'open connections (0: the plan\'s own number)' }, 'max-inflight': { type: 'string', value: '<n>', help: 'calls in flight (0: the plan\'s own number)' } },
    run: async (ctx) => {
      const keyId = id(ctx, 'usage: carbium keys limits <id> [--max-connections n] [--max-inflight n]')
      const mc = ctx.str('max-connections')
      const mi = ctx.str('max-inflight')
      if (mc === undefined && mi === undefined) throw new CliError(EXIT.usage, 'give --max-connections, --max-inflight or both')
      const limit = (flag: string, v: string): number => {
        if (!/^\d+$/.test(v) || Number(v) > 10000) throw new CliError(EXIT.usage, `--${flag} takes a whole number from 0 to 10000 (0 is the plan's own number), not ${v}`)
        return Number(v)
      }
      return ctx.account().keys.setLimits(keyId, { ...(mc === undefined ? {} : { max_connections: limit('max-connections', mc) }), ...(mi === undefined ? {} : { max_inflight: limit('max-inflight', mi) }) })
    },
  },
  // webhooks
  { path: ['webhooks', 'list'], summary: 'the webhooks (without address lists)', access: 'account', run: async (ctx) => ctx.account().webhooks.list() },
  { path: ['webhooks', 'get'], summary: 'one webhook with its addresses', usage: '<id>', access: 'account', run: async (ctx) => ctx.account().webhooks.get(id(ctx, 'usage: carbium webhooks get <id>')) },
  {
    path: ['webhooks', 'deliveries'], summary: 'the delivery log, newest first', usage: '<id>', access: 'account', options: { limit: { type: 'string', value: '<n>', help: 'lines (default 50, max 200)' }, before: { type: 'string', value: '<cursor|unix-ms>', help: 'page from here' } },
    run: async (ctx) => ctx.account().webhooks.deliveries(id(ctx, 'usage: carbium webhooks deliveries <id>'), { ...(ctx.str('limit') ? { limit: Number(ctx.str('limit')) } : {}), ...(ctx.str('before') ? { before: ctx.str('before') as string } : {}) }),
  },
  {
    path: ['webhooks', 'create'], summary: 'a webhook: signed POSTs of finalized transactions for addresses to your https URL; the signing secret goes to --secret-file only', access: 'write', scope: 'webhooks:write',
    options: { 'key-id': { type: 'string', value: '<id>', help: 'the service key whose credits pay the deliveries' }, url: { type: 'string', value: '<https url>', help: 'https on 443 at a public host name' }, address: { type: 'string', multiple: true, value: '<base58>', help: 'an address to watch, repeatable' }, name: { type: 'string', value: '<name>', help: 'a label' }, 'tx-status': { type: 'string', value: 'all|success|failed', help: 'which transactions (default all)' }, 'auth-header-env': { type: 'string', value: '<VAR>', help: 'send the value of this environment variable as the Authorization header of every delivery' }, 'secret-file': { type: 'string', value: '<path>', help: 'required: the whsec_ secret is written to this new 0600 file' } },
    run: async (ctx) => {
      const keyId = Number(ctx.str('key-id'))
      const url = ctx.str('url')
      const addresses = ctx.list('address')
      const secretFile = ctx.str('secret-file')
      if (!Number.isInteger(keyId) || !url || !addresses.length || !secretFile) throw new CliError(EXIT.usage, 'usage: carbium webhooks create --key-id <id> --url <https> --address <a>... --secret-file <path>')
      const auth = authHeader(ctx)
      const made = await withSecretFile(ctx, secretFile, (m) => m.webhook.webhook_id, () => ctx.account().webhooks.create({ key_id: keyId, url, addresses, ...(ctx.str('name') ? { name: ctx.str('name') as string } : {}), ...(ctx.str('tx-status') ? { tx_status: ctx.str('tx-status') as 'all' } : {}), ...(auth ? { auth_header: auth } : {}) }))
      return { webhook: made.webhook, secretFile }
    },
  },
  {
    path: ['webhooks', 'update'], summary: 'change a webhook: --url, --address (replaces the list), --name, --tx-status, --key-id, the Authorization header', usage: '<id>', access: 'write', scope: 'webhooks:write',
    options: { url: { type: 'string', value: '<https url>', help: 'new URL; it clears a stored Authorization header unless --auth-header-env or --clear-auth-header goes with it' }, address: { type: 'string', multiple: true, value: '<base58>', help: 'the new address list, repeatable' }, name: { type: 'string', value: '<name>', help: 'new label' }, 'tx-status': { type: 'string', value: 'all|success|failed', help: 'which transactions' }, 'key-id': { type: 'string', value: '<id>', help: 'the service key whose credits pay the deliveries' }, 'auth-header-env': { type: 'string', value: '<VAR>', help: 'send the value of this environment variable as the Authorization header of every delivery' }, 'clear-auth-header': { type: 'boolean', help: 'send no Authorization header' } },
    run: async (ctx) => {
      const wid = id(ctx, 'usage: carbium webhooks update <id> [--url] [--address...] [--name] [--tx-status] [--key-id] [--auth-header-env VAR | --clear-auth-header]')
      const url = ctx.str('url')
      const keyId = ctx.str('key-id')
      if (keyId !== undefined && !(Number.isInteger(Number(keyId)) && Number(keyId) > 0)) throw new CliError(EXIT.usage, '--key-id takes a service key id')
      const auth = authHeader(ctx)
      if (url && auth === undefined && (await ctx.account().webhooks.get(wid)).has_auth_header) throw new CliError(EXIT.usage, `webhook ${wid} sends an Authorization header, and a new URL without one clears it`, 'add --auth-header-env <VAR> to send one to the new URL, or --clear-auth-header to drop it')
      return ctx.account().webhooks.update(wid, { ...(url ? { url } : {}), ...(ctx.list('address').length ? { addresses: ctx.list('address') } : {}), ...(ctx.str('name') ? { name: ctx.str('name') as string } : {}), ...(ctx.str('tx-status') ? { tx_status: ctx.str('tx-status') as 'all' } : {}), ...(keyId === undefined ? {} : { key_id: Number(keyId) }), ...(auth === undefined ? {} : { auth_header: auth }) })
    },
  },
  { path: ['webhooks', 'pause'], summary: 'pause a webhook', usage: '<id>', access: 'write', scope: 'webhooks:write', run: async (ctx) => ctx.account().webhooks.update(id(ctx, 'usage: carbium webhooks pause <id>'), { status: 'paused' }) },
  { path: ['webhooks', 'resume'], summary: 'resume a paused webhook', usage: '<id>', access: 'write', scope: 'webhooks:write', run: async (ctx) => ctx.account().webhooks.update(id(ctx, 'usage: carbium webhooks resume <id>'), { status: 'active' }) },
  { path: ['webhooks', 'test'], summary: 'send one signed test event (1 credit when delivered); read outcome, not the HTTP status', usage: '<id>', access: 'write', scope: 'webhooks:write', run: async (ctx) => ctx.account().webhooks.test(id(ctx, 'usage: carbium webhooks test <id>')) },
  {
    path: ['webhooks', 'rotate'], summary: 'a new signing secret (the old one signs for a day too); written to --secret-file only', usage: '<id>', access: 'destructive', scope: 'webhooks:write', options: { 'secret-file': { type: 'string', value: '<path>', help: 'required: the new whsec_ secret goes to this new 0600 file' } },
    run: async (ctx) => {
      const wid = id(ctx, 'usage: carbium webhooks rotate <id> --secret-file <path>')
      const secretFile = ctx.str('secret-file')
      if (!secretFile) throw new CliError(EXIT.usage, '--secret-file is required: the secret is never printed')
      await ctx.confirm(`rotate the secret of webhook ${wid}?`)
      const r = await withSecretFile(ctx, secretFile, () => wid, () => ctx.account().webhooks.rotateSecret(wid))
      return { secret_hint: r.secret_hint, previous_valid_until: r.previous_valid_until, secretFile }
    },
  },
  {
    path: ['webhooks', 'delete'], summary: 'delete a webhook', usage: '<id>', access: 'destructive', scope: 'webhooks:write',
    run: async (ctx) => {
      const wid = id(ctx, 'usage: carbium webhooks delete <id>')
      await ctx.confirm(`delete webhook ${wid}?`)
      return ctx.account().webhooks.delete(wid)
    },
  },
  // usage and the account
  {
    path: ['usage'], summary: 'credits and calls: this period per key (default), --daily, --hourly, --latency or --load', access: 'account',
    options: { daily: { type: 'boolean', help: 'per UTC day and method (--from, --to as YYYY-MM-DD, at most 90 days)' }, hourly: { type: 'boolean', help: 'per hour and method class (--from, --to RFC 3339, at most 7 days)' }, latency: { type: 'boolean', help: 'p50, p95 and p99 per hour' }, load: { type: 'boolean', help: 'requests per second per key now' }, from: { type: 'string', value: '<date>', help: 'start' }, to: { type: 'string', value: '<date>', help: 'end' }, 'key-id': { type: 'string', value: '<id>', help: 'one key only' }, group: { type: 'boolean', help: 'with --daily: one row per key' } },
    run: async (ctx) => {
      const u = ctx.account().usage
      if (ctx.bool('daily')) return u.daily({ ...range(ctx), ...(ctx.bool('group') ? { group: 'key' as const } : {}) })
      if (ctx.bool('hourly')) return u.hourly(range(ctx))
      if (ctx.bool('latency')) return u.latency(range(ctx))
      if (ctx.bool('load')) return u.load()
      return u.perKey()
    },
  },
  { path: ['balance'], summary: 'credits granted, used and remaining', access: 'account', run: async (ctx) => ctx.account().account.balance() },
  { path: ['account'], summary: 'the account record: tier, term, status', access: 'account', run: async (ctx) => ctx.account().account.get() },
  { path: ['account', 'invoices'], summary: 'the credit periods', access: 'account', run: async (ctx) => ctx.account().account.invoices() },
  { path: ['account', 'payments'], summary: 'the payments made', access: 'account', run: async (ctx) => ctx.account().account.payments() },
  { path: ['account', 'crypto-intent'], summary: 'the state of a crypto payment intent made on the dashboard', usage: '<intent_id>', access: 'account', run: async (ctx) => { const i = Number(ctx.positionals[0]); if (!Number.isInteger(i) || i <= 0) throw new CliError(EXIT.usage, 'usage: carbium account crypto-intent <intent_id>'); return ctx.account().account.cryptoIntent(i) } },
  { path: ['modules'], summary: 'the modules (quote) with their plans and what the account holds', access: 'account', run: async (ctx) => ctx.account().account.modules() },
  {
    path: ['modules', 'enable'], summary: 'enable a free plan of a module, for example quote (paid plans are bought on the dashboard)', usage: '<module>', access: 'write', scope: 'modules:write', options: { plan: { type: 'string', value: '<plan>', help: 'the plan (default free)' } },
    run: async (ctx) => { const m = ctx.positionals[0]; if (!m) throw new CliError(EXIT.usage, 'usage: carbium modules enable <module> [--plan free]'); return ctx.account().modules.enableFree(m, ctx.str('plan') ?? 'free') },
  },
  { path: ['plans'], summary: 'the plans and prices (public)', access: 'keyless', run: async (ctx) => CarbiumSession.plans(ctx.sessionOptions()) },
])
