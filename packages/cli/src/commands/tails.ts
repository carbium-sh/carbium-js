import { base58Encode } from '../base58.ts'
import { CliError, EXIT, register, type Ctx } from '../main.ts'

/**
 * Carbon Stream needs the native Yellowstone gRPC client, which a standalone binary cannot load: it says so before any key
 * check or import, so the binary never loads a node_modules it finds in the working directory.
 */
async function streamModule(): Promise<typeof import('@carbium/sdk/stream')> {
  if ((globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable) throw new CliError(EXIT.usage, 'Carbon Stream is not in the standalone binary; it needs the native Yellowstone gRPC client, which only the npm package loads', 'on linux-x64 or macOS: npm install -g carbium @triton-one/yellowstone-grpc; in this binary, carbium ws tail and carbium rpc work')
  return import('@carbium/sdk/stream')
}

const BASE58_FIELDS = /^(pubkey|owner|signature|txnSignature|signatures|accountKeys|recentBlockhash|loadedWritableAddresses|loadedReadonlyAddresses|hash|blockhash|parentBlockhash|programId)$/

/** Bytes as base58 where they are keys, signatures or hashes, base64 elsewhere; bigints as decimal strings; dates as ISO strings. */
export function jsonable(v: unknown, key = ''): unknown {
  if (v instanceof Uint8Array) return BASE58_FIELDS.test(key) ? base58Encode(v) : Buffer.from(v).toString('base64')
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map((x) => jsonable(x, key))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, jsonable(x, k)]))
  return v
}

function split(s: string | undefined): string[] {
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []
}

function stopSignal(ctx: Ctx, onStop: () => void): () => void {
  const onInt = (): void => {
    onStop()
    process.off('SIGINT', onInt)
  }
  process.on('SIGINT', onInt)
  ctx.io.signal?.addEventListener('abort', onStop, { once: true })
  return () => process.off('SIGINT', onInt)
}

register([
  {
    path: ['ws', 'tail'], summary: 'tail a WebSocket subscription as NDJSON until Ctrl-C or --count: account <pubkey>, program <programId>, logs all|allWithVotes|<address>, signature <sig>, slot, root, slotsUpdates, block all|<address>', usage: '<subscription> [arg]', access: 'service',
    options: { count: { type: 'string', value: '<n>', help: 'stop after n notifications' }, commitment: { type: 'string', value: '<level>', help: 'processed, confirmed or finalized' }, encoding: { type: 'string', value: '<enc>', help: 'account data encoding (default base64)' } },
    run: async (ctx) => {
      const [sub, arg] = ctx.positionals
      const max = ctx.str('count') ? Number(ctx.str('count')) : Infinity
      const commitment = ctx.str('commitment') as 'processed' | 'confirmed' | 'finalized' | undefined
      if (sub === 'block' && commitment === 'processed') throw new CliError(EXIT.usage, 'blockSubscribe takes --commitment confirmed or finalized, not processed')
      let fail: (e: unknown) => void = () => undefined
      // a fatal close (a revoked key, credits gone) or a refused re-subscribe ends the tail with its error
      const socket = ctx.carbium().socket({ onReseed: (i) => ctx.err(`reseed: code ${i.code} ${i.reason} gap ${i.gap}; re-read state you keep`), onState: (s, i) => ctx.err(`socket ${s}${i ? ` ${i.code} ${i.reason}` : ''}`), onFatal: (e) => fail(e), onError: (e) => fail(e) })
      let n = 0
      const done = new Promise<void>((resolve, reject) => {
        fail = reject
        const emit = (method: string, result: unknown): void => {
          ctx.out(JSON.stringify({ method, result: jsonable(result) }))
          if (++n >= max) resolve()
        }
        const cfg = commitment ? { commitment } : undefined
        let s
        switch (sub) {
          case 'account': if (!arg) return reject(new CliError(EXIT.usage, 'usage: carbium ws tail account <pubkey>')); s = socket.accountSubscribe(arg, (r) => emit('accountNotification', r), { ...(cfg ?? {}), encoding: (ctx.str('encoding') ?? 'base64') as 'base64' }); break
          case 'program': if (!arg) return reject(new CliError(EXIT.usage, 'usage: carbium ws tail program <programId>')); s = socket.programSubscribe(arg, (r) => emit('programNotification', r), { ...(cfg ?? {}), encoding: (ctx.str('encoding') ?? 'base64') as 'base64' }); break
          case 'logs': s = socket.logsSubscribe(arg === 'all' || arg === 'allWithVotes' ? arg : arg ? { mentions: [arg] } : 'all', (r) => emit('logsNotification', r), cfg); break
          case 'signature': if (!arg) return reject(new CliError(EXIT.usage, 'usage: carbium ws tail signature <sig>')); s = socket.signatureSubscribe(arg, (r) => { emit('signatureNotification', r); resolve() }, cfg); break
          case 'slot': s = socket.slotSubscribe((r) => emit('slotNotification', r)); break
          case 'root': s = socket.rootSubscribe((r) => emit('rootNotification', r)); break
          case 'slotsUpdates': s = socket.slotsUpdatesSubscribe((r) => emit('slotsUpdatesNotification', r)); break
          case 'block': s = socket.blockSubscribe(arg && arg !== 'all' ? { mentionsAccountOrProgram: arg } : 'all', (r) => emit('blockNotification', r), commitment && commitment !== 'processed' ? { commitment } : {}); break
          default: return reject(new CliError(EXIT.usage, 'subscription must be one of account, program, logs, signature, slot, root, slotsUpdates, block'))
        }
        s.ready.then((id) => ctx.err(`subscribed (server id ${id})`), reject)
        socket.subscribe // keep the typed socket in scope
        stopSignal(ctx, resolve)
      })
      try {
        await done
      } finally {
        socket.close()
        ctx.err(`closed after ${n} notification${n === 1 ? '' : 's'}`)
      }
      return undefined
    },
  },
  {
    path: ['stream', 'tail'], summary: 'tail Carbon Stream (Yellowstone gRPC) as NDJSON until Ctrl-C or --count; needs a DEV plan or above and the grpc scope', access: 'service',
    options: {
      accounts: { type: 'string', value: '<pubkeys>', help: 'account updates for these accounts (comma separated)' },
      owners: { type: 'string', value: '<programs>', help: 'account updates for accounts owned by these programs (heavy without --accounts)' },
      'tx-include': { type: 'string', value: '<pubkeys>', help: 'transactions that include any of these accounts' },
      'tx-required': { type: 'string', value: '<pubkeys>', help: 'transactions that include all of these accounts' },
      'tx-exclude': { type: 'string', value: '<pubkeys>', help: 'transactions that include none of these accounts' },
      'tx-status': { type: 'boolean', help: 'transaction statuses instead of full transactions' },
      vote: { type: 'boolean', help: 'include vote transactions' },
      failed: { type: 'boolean', help: 'include failed transactions' },
      slots: { type: 'boolean', help: 'slot updates' },
      'blocks-meta': { type: 'boolean', help: 'block metadata' },
      blocks: { type: 'boolean', help: 'whole blocks for --tx-include accounts (heavy)' },
      entry: { type: 'boolean', help: 'entries (heavy)' },
      commitment: { type: 'string', value: '<level>', help: 'processed (default), confirmed or finalized' },
      'from-slot': { type: 'string', value: '<slot>', help: 'replay from this slot (processed only)' },
      count: { type: 'string', value: '<n>', help: 'stop after n updates' },
    },
    run: async (ctx) => {
      const stream = await streamModule()
      const accounts = split(ctx.str('accounts'))
      const owners = split(ctx.str('owners'))
      const include = split(ctx.str('tx-include'))
      const required = split(ctx.str('tx-required'))
      const exclude = split(ctx.str('tx-exclude'))
      const filters: import('@carbium/sdk/stream').StreamFilters = {}
      if (accounts.length || owners.length) filters.accounts = { cli: { account: accounts, owner: owners, filters: [], nonemptyTxnSignature: false } }
      if (include.length || required.length || exclude.length) {
        const f = { accountInclude: include, accountRequired: required, accountExclude: exclude, vote: ctx.bool('vote'), failed: ctx.bool('failed') }
        if (ctx.bool('tx-status')) filters.transactionsStatus = { cli: f }
        else filters.transactions = { cli: f }
      }
      if (ctx.bool('slots')) filters.slots = { cli: { filterByCommitment: true } }
      if (ctx.bool('blocks-meta')) filters.blocksMeta = { cli: {} }
      if (ctx.bool('blocks')) filters.blocks = { cli: { accountInclude: include, includeTransactions: true, includeAccounts: false, includeEntries: false } }
      if (ctx.bool('entry')) filters.entry = { cli: {} }
      if (!Object.keys(filters).length) throw new CliError(EXIT.usage, 'name at least one filter: --accounts, --owners, --tx-include, --slots, --blocks-meta, --blocks or --entry')
      const level = ctx.str('commitment')
      if (level) filters.commitment = ({ processed: 0, confirmed: 1, finalized: 2 } as Record<string, 0 | 1 | 2>)[level] ?? (() => { throw new CliError(EXIT.usage, 'commitment must be processed, confirmed or finalized') })()
      const from = ctx.str('from-slot')
      if (from) filters.fromSlot = from
      if (owners.length && !accounts.length) ctx.err('note: an owner filter without accounts is a heavy stream (BUSINESS or PRO, 200 credits)')
      if (exclude.length && !include.length && !required.length) ctx.err('note: --tx-exclude alone is every other transaction, a heavy stream (BUSINESS or PRO, 200 credits)')
      const client = await stream.CarbiumStream.connect({ apiKey: ctx.serviceKey(), endpoint: ctx.streamUrl() })
      const max = ctx.str('count') ? Number(ctx.str('count')) : Infinity
      let n = 0
      const live = client.subscribeWithReconnect(filters, {
        onUpdate: (u) => {
          ctx.out(JSON.stringify(jsonable(u)))
          if (++n >= max) live.close()
        },
        onReseed: ({ lastSlot }) => ctx.err(`reseed after slot ${lastSlot ?? '?'}: re-read state you keep over RPC`),
        onStatus: (e) => ctx.err(e.type === 'connected' ? `connected${e.fromSlot ? ` from slot ${e.fromSlot}` : ''}` : e.type === 'retry' ? `retry in ${e.delayMs} ms: ${e.error.reason ?? ''} ${e.error.message}` : e.type === 'stopped' ? 'stopped' : `reseed: ${e.error?.message ?? ''}`),
      })
      const unhook = stopSignal(ctx, () => live.close())
      try {
        await live.done
      } finally {
        unhook()
        ctx.err(`closed after ${n} update${n === 1 ? '' : 's'}`)
      }
      return undefined
    },
  },
  ...(['slot', 'block-height', 'latest-blockhash', 'blockhash-valid', 'version', 'ping', 'replay-info'] as const).map((name) => ({
    path: ['stream', name], summary: `Carbon Stream unary call ${name} (1 credit)`, usage: name === 'blockhash-valid' ? '<blockhash>' : name === 'ping' ? '[count]' : '', access: 'service' as const,
    options: { commitment: { type: 'string' as const, value: '<level>', help: 'processed, confirmed or finalized' } },
    run: async (ctx: Ctx) => {
      const stream = await streamModule()
      const client = await stream.CarbiumStream.connect({ apiKey: ctx.serviceKey(), endpoint: ctx.streamUrl() })
      const level = ctx.str('commitment')
      const c = level ? ({ processed: 0, confirmed: 1, finalized: 2 } as Record<string, 0 | 1 | 2>)[level] : undefined
      switch (name) {
        case 'slot': return jsonable(await client.getSlot(c))
        case 'block-height': return jsonable(await client.getBlockHeight(c))
        case 'latest-blockhash': return jsonable(await client.getLatestBlockhash(c))
        case 'blockhash-valid': { const h = ctx.positionals[0]; if (!h) throw new CliError(EXIT.usage, 'usage: carbium stream blockhash-valid <blockhash>'); return jsonable(await client.isBlockhashValid(h, c)) }
        case 'version': return jsonable(await client.getVersion())
        case 'ping': return jsonable(await client.ping(Number(ctx.positionals[0] ?? 1)))
        case 'replay-info': return jsonable(await client.subscribeReplayInfo())
      }
    },
  })),
])
