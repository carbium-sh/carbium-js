import { readFileSync } from 'node:fs'
import { METHODS, type MethodName } from '@carbium/sdk'
import { CliError, EXIT, pairs, register, value, type Command, type Ctx } from '../main.ts'

/** Every served RPC-plane method except sendTransaction, which sends. */
export const RPC_METHODS: readonly string[] = (Object.keys(METHODS) as MethodName[]).filter((m) => METHODS[m].plane === 'rpc' && m !== 'sendTransaction').sort()
export const DAS_METHODS: readonly string[] = (Object.keys(METHODS) as MethodName[]).filter((m) => METHODS[m].plane === 'das').sort()

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Shapes whose worst case passes about 1,000 credits need --confirm-cost; some limits are capped whatever the flag. */
export function costGate(method: string, params: unknown[], confirm: boolean): unknown[] {
  const p = [...params]
  const refuse = (why: string): never => {
    throw new CliError(EXIT.usage, `not run: ${why}`, 'pass --confirm-cost to run it anyway')
  }
  switch (method) {
    case 'getProgramAccounts': {
      const cfg = obj(p[1])
      if (!(Array.isArray(cfg['filters']) && cfg['filters'].length) && !confirm) refuse('getProgramAccounts with no filters reads a whole program (505 credits, up to 10,000 accounts); add filters')
      return p
    }
    case 'getMultipleAccounts': {
      const n = Array.isArray(p[0]) ? p[0].length : 0
      if (n > 100 && !confirm) refuse(`getMultipleAccounts of ${n} keys costs ${n * 10} credits (10 per key); ask for 100 or fewer per call`)
      return p
    }
    case 'getTokenAccountsByOwner':
    case 'getTokenAccountsByDelegate':
      if (!('mint' in obj(p[1])) && !confirm) refuse('a token scan by programId can cost up to 100,005 credits; filter by mint, or use carbium das getTokenAccounts (1 credit)')
      return p
    case 'getTransactionsForAddress': {
      const cfg = obj(p[1])
      const full = cfg['transactionDetails'] === 'full'
      if ((full || cfg['sortOrder'] === 'asc' || cfg['filters'] !== undefined) && !confirm) refuse('a getTransactionsForAddress walk can cost up to 51,255 credits at limit 1000; page descending with no filters (55 credits)')
      return p
    }
    case 'getBlock': {
      const cfg = obj(p[1])
      if (cfg['transactionDetails'] === 'full' && !confirm) refuse('a full getBlock returns every transaction of the block; use transactionDetails signatures or accounts')
      p[1] = { transactionDetails: 'signatures', rewards: false, ...cfg }
      return p
    }
    default:
      return p
  }
}

function paramsFrom(ctx: Ctx, positional: string[]): unknown[] {
  const json = ctx.str('params-json')
  if (json !== undefined) {
    const parsed = value(json === '-' ? readStdin(ctx) : json)
    if (!Array.isArray(parsed)) throw new CliError(EXIT.usage, '--params-json must be a JSON array')
    return parsed
  }
  return positional.map(value)
}

function readStdin(ctx: Ctx): string {
  const stdin = ctx.io.stdin as (NodeJS.ReadableStream & { fd?: number }) | undefined
  if (!stdin) throw new CliError(EXIT.usage, 'no stdin')
  return readFileSync(stdin.fd ?? 0, 'utf8')
}

const confirmCost = { 'confirm-cost': { type: 'boolean' as const, help: 'run a shape that can cost over about 1,000 credits' } }

const rpcCommands: Command[] = [
  {
    path: ['rpc'], summary: `call a served JSON-RPC method by name with positional params (JSON values); ${RPC_METHODS.length} methods, see carbium rpc list; with no key the services answer only their public methods`, usage: '<method> [params...]', access: 'service',
    options: { ...confirmCost, 'params-json': { type: 'string', value: '<json|->', help: 'the whole params array as JSON (- reads stdin)' } },
    run: async (ctx) => {
      const [method, ...rest] = ctx.positionals
      if (!method) throw new CliError(EXIT.usage, 'usage: carbium rpc <method> [params...]; carbium rpc list shows the served methods')
      if (!RPC_METHODS.includes(method)) throw new CliError(EXIT.usage, `${method} is not a served method${method === 'sendTransaction' ? ' here: the CLI never sends a transaction' : ''}`, 'carbium rpc list')
      const params = costGate(method, paramsFrom(ctx, rest), ctx.bool('confirm-cost'))
      const fn = (ctx.carbium().rpc as unknown as Record<string, (...p: unknown[]) => Promise<unknown>>)[method]
      if (!fn) throw new CliError(EXIT.usage, `${method} is not a served method`)
      return fn(...params)
    },
  },
  { path: ['rpc', 'list'], summary: 'the served JSON-RPC methods (offline)', access: 'local', run: async () => RPC_METHODS.map((m) => ({ method: m, params: METHODS[m as MethodName].params, batch: METHODS[m as MethodName].batch })) },
  {
    path: ['das'], summary: `call a DAS method with key=value params (Helius field names; values parse as JSON); ${DAS_METHODS.length} methods, see carbium das list`, usage: '<method> [key=value...]', access: 'service',
    options: { 'params-json': { type: 'string', value: '<json|->', help: 'the params object as JSON (- reads stdin)' } },
    run: async (ctx) => {
      const [method, ...rest] = ctx.positionals
      if (!method) throw new CliError(EXIT.usage, 'usage: carbium das <method> [key=value...]')
      if (!DAS_METHODS.includes(method)) throw new CliError(EXIT.usage, `${method} is not a served DAS method`, 'carbium das list')
      const json = ctx.str('params-json')
      const params = json !== undefined ? value(json === '-' ? readStdin(ctx) : json) : pairs(rest)
      const fn = (ctx.carbium().das as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method]
      if (!fn) throw new CliError(EXIT.usage, `${method} is not a served DAS method`)
      return fn(params)
    },
  },
  { path: ['das', 'list'], summary: 'the served DAS methods (offline)', access: 'local', run: async () => DAS_METHODS },
  {
    path: ['quote'], summary: 'a swap quote: amount in base units of the source mint (--rest: the old path, GET /cq1/quote)', usage: '<src_mint> <dst_mint> <amount_in>', access: 'public',
    options: { 'slippage-bps': { type: 'string', value: '<n>', help: 'slippage in basis points (default 50)' }, dex: { type: 'string', value: '<labels>', help: 'pin venue families, comma separated' }, 'tx-version': { type: 'string', value: '0|1', help: 'v0 with lookup tables (default) or v1' }, rest: { type: 'boolean', help: 'ask GET /cq1/quote instead: one plain object, every value a string; takes no --dex or --tx-version' } },
    run: async (ctx) => {
      const [src, dst, amount] = ctx.positionals
      if (!src || !dst || !amount) throw new CliError(EXIT.usage, 'usage: carbium quote <src_mint> <dst_mint> <amount_in>')
      const dex = ctx.str('dex')
      const txv = ctx.str('tx-version')
      if (ctx.bool('rest')) {
        if (dex || txv) throw new CliError(EXIT.usage, 'the old path takes only the pair, the amount and --slippage-bps; drop --dex and --tx-version, or drop --rest')
        return ctx.carbium().cq1Quote({ src_mint: src, dst_mint: dst, amount_in: amount, slippage_bps: Number(ctx.str('slippage-bps') ?? 50) })
      }
      return ctx.carbium().quote.quote({ src_mint: src, dst_mint: dst, amount_in: amount, slippage_bps: Number(ctx.str('slippage-bps') ?? 50), ...(dex ? { dex: dex.split(',') } : {}), ...(txv ? { txVersion: Number(txv) as 0 | 1 } : {}) })
    },
  },
  {
    path: ['swap', 'build'], summary: 'build ONE unsigned swap transaction from a quote for your own wallet to sign and send; the CLI never signs or sends', usage: '<quote_id> <user_pubkey>', access: 'public',
    options: { 'cu-price': { type: 'string', value: '<micro-lamports>', help: 'priority price per compute unit (default: the network price)' }, out: { type: 'string', value: '<path>', help: 'also write the base64 transaction to this new file' } },
    run: async (ctx) => {
      const [quote_id, user_pubkey] = ctx.positionals
      if (!quote_id || !user_pubkey) throw new CliError(EXIT.usage, 'usage: carbium swap build <quote_id> <user_pubkey>')
      const cu = ctx.str('cu-price')
      const built = await ctx.carbium().quote.swap({ quote_id, user_pubkey, ...(cu ? { compute_unit_price_micro_lamports: Number(cu) } : {}) })
      const out = ctx.str('out')
      if (out) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(out, built.transaction + '\n', { flag: 'wx' })
        ctx.err(`unsigned transaction written to ${out}; sign it with your wallet and send it before block height ${built.lastValidBlockHeight}`)
      }
      return built
    },
  },
  { path: ['prices'], summary: 'USD prices and TVL for up to 64 mints', usage: '<mint...>', access: 'public', run: async (ctx) => { if (!ctx.positionals.length) throw new CliError(EXIT.usage, 'usage: carbium prices <mint...>'); return ctx.carbium().quote.prices({ mints: ctx.positionals }) } },
  {
    path: ['health'], summary: 'the door (getHealth) and the quote plane (health) in one answer', access: 'public',
    run: async (ctx) => {
      const c = ctx.carbium()
      const t0 = Date.now()
      const rpc = await c.rpc.getHealth()
      const rpcMs = Date.now() - t0
      const quote = await c.quote.health().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      return { rpc, rpcMs, quote }
    },
  },
  {
    path: ['test'], summary: 'reach the services, with your key when one is set: getHealth, getLatestBlockhash and, with --ws (needs a key), one slot notification', access: 'public', options: { ws: { type: 'boolean', help: 'also open a WebSocket and wait for one slot notification' } },
    run: async (ctx) => {
      if (ctx.bool('ws')) ctx.serviceKey() // a WebSocket takes a key: refuse here, not at the handshake
      const c = ctx.carbium()
      const checks: Array<Record<string, unknown>> = []
      let t0 = Date.now()
      checks.push({ check: 'getHealth', result: await c.rpc.getHealth(), ms: Date.now() - t0 })
      t0 = Date.now()
      const bh = await c.rpc.getLatestBlockhash()
      checks.push({ check: 'getLatestBlockhash', result: `slot ${bh.context.slot}, valid until block height ${bh.value.lastValidBlockHeight}`, ms: Date.now() - t0 })
      if (ctx.bool('ws')) {
        t0 = Date.now()
        const socket = c.socket()
        const slot = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CliError(EXIT.service, 'no slot notification within 15 s')), 15_000)
          socket.slotSubscribe((n) => { clearTimeout(timer); resolve(n.slot) }).ready.catch((e: unknown) => { clearTimeout(timer); reject(e) })
        }).finally(() => socket.close())
        checks.push({ check: 'slotSubscribe', result: `slot ${slot}`, ms: Date.now() - t0 })
      }
      return checks
    },
  },
]
register(rpcCommands)
