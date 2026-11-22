import type { DcaOpenRequest } from '@carbium/sdk'
import { CliError, EXIT, register, type Ctx } from '../main.ts'

const owner = (ctx: Ctx, usage: string): string => {
  const o = ctx.positionals[0]
  if (!o) throw new CliError(EXIT.usage, usage)
  return o
}
const num = (ctx: Ctx, name: string): number | undefined => (ctx.str(name) === undefined ? undefined : Number(ctx.str(name)))

register([
  {
    path: ['dca', 'quote'], summary: 'a price for one DCA buy, the fee rate and the owner limits (keyless)', usage: '<inputMint> <outputMint> <amount>', access: 'keyless',
    options: { 'slippage-bps': { type: 'string', value: '<n>', help: 'slippage in basis points' }, owner: { type: 'string', value: '<pubkey>', help: 'the owner, for its limits and the SOL cost' } },
    run: async (ctx) => {
      const [inputMint, outputMint, amount] = ctx.positionals
      if (!inputMint || !outputMint || !amount) throw new CliError(EXIT.usage, 'usage: carbium dca quote <inputMint> <outputMint> <amount>')
      return ctx.dca().quote({ inputMint, outputMint, amount, ...(num(ctx, 'slippage-bps') === undefined ? {} : { slippageBps: num(ctx, 'slippage-bps') as number }), ...(ctx.str('owner') ? { owner: ctx.str('owner') as string } : {}) })
    },
  },
  { path: ['dca', 'positions'], summary: 'the owner open positions (keyless)', usage: '<owner>', access: 'keyless', options: { after: { type: 'string', value: '<cursor>', help: 'the next value of the last answer' } }, run: async (ctx) => ctx.dca().positions(owner(ctx, 'usage: carbium dca positions <owner>'), ctx.str('after') ? { after: ctx.str('after') as string } : {}) },
  { path: ['dca', 'history'], summary: 'the owner ended DCAs, newest close first (keyless)', usage: '<owner>', access: 'keyless', options: { after: { type: 'string', value: '<cursor>', help: 'the next value of the last answer' } }, run: async (ctx) => ctx.dca().history(owner(ctx, 'usage: carbium dca history <owner>'), ctx.str('after') ? { after: ctx.str('after') as string } : {}) },
  { path: ['dca', 'position'], summary: 'one position with its fills, or its closed record (keyless)', usage: '<address>', access: 'keyless', options: { 'opened-slot': { type: 'string', value: '<slot>', help: 'an earlier opening of the same address' } }, run: async (ctx) => ctx.dca().position(owner(ctx, 'usage: carbium dca position <address>'), num(ctx, 'opened-slot') === undefined ? {} : { openedSlot: num(ctx, 'opened-slot') as number }) },
  { path: ['dca', 'health'], summary: 'the keeper state (keyless, never metered)', access: 'keyless', run: async (ctx) => ctx.dca().health() },
  {
    path: ['dca', 'build', 'open'], summary: 'build ONE unsigned transaction that opens a DCA for your own wallet to sign and send; the CLI never signs or sends', access: 'keyless',
    options: { owner: { type: 'string', value: '<pubkey>', help: 'the wallet that signs and pays' }, in: { type: 'string', value: '<mint>', help: 'the input mint' }, out: { type: 'string', value: '<mint>', help: 'the output mint' }, cycles: { type: 'string', value: '<n>', help: 'number of buys' }, 'amount-per-cycle': { type: 'string', value: '<base units>', help: 'per buy (or --total)' }, total: { type: 'string', value: '<base units>', help: 'in total (or --amount-per-cycle)' }, 'interval-secs': { type: 'string', value: '<s>', help: 'between buys (or --frequency)' }, frequency: { type: 'string', value: 'hourly|daily|weekly|biweekly|monthly', help: 'between buys (or --interval-secs)' }, 'min-out-e6': { type: 'string', value: '<n>', help: 'a floor on the output per 1e6 input (or --max-price)' }, 'max-price': { type: 'string', value: '<n>', help: 'a maximum price (or --min-out-e6)' }, 'max-slippage-bps': { type: 'string', value: '<n>', help: 'default 50, cap 300' }, 'start-at': { type: 'string', value: '<unix s>', help: 'first buy time, up to 30 days ahead' }, index: { type: 'string', value: '<0-255>', help: 'for several positions on one pair' }, 'tx-out': { type: 'string', value: '<path>', help: 'also write the base64 transaction to this new file' } },
    run: async (ctx) => {
      const o = ctx.str('owner'), i = ctx.str('in'), out = ctx.str('out'), cycles = num(ctx, 'cycles')
      if (!o || !i || !out || cycles === undefined) throw new CliError(EXIT.usage, 'usage: carbium dca build open --owner <pubkey> --in <mint> --out <mint> --cycles <n> (--amount-per-cycle <a> | --total <a>) (--interval-secs <s> | --frequency <f>)')
      const base = { owner: o, inputMint: i, outputMint: out, cycles, ...(num(ctx, 'max-slippage-bps') === undefined ? {} : { maxSlippageBps: num(ctx, 'max-slippage-bps') as number }), ...(num(ctx, 'start-at') === undefined ? {} : { startAt: num(ctx, 'start-at') as number }), ...(num(ctx, 'index') === undefined ? {} : { index: num(ctx, 'index') as number }), ...(ctx.str('min-out-e6') ? { minOutE6: ctx.str('min-out-e6') as string } : {}), ...(ctx.str('max-price') ? { maxPrice: ctx.str('max-price') as string } : {}) }
      const amount = ctx.str('amount-per-cycle') ? { amountPerCycle: ctx.str('amount-per-cycle') as string } : ctx.str('total') ? { totalAmount: ctx.str('total') as string } : undefined
      const interval = ctx.str('interval-secs') ? { intervalSecs: Number(ctx.str('interval-secs')) } : ctx.str('frequency') ? { frequency: ctx.str('frequency') as 'daily' } : undefined
      if (!amount || !interval) throw new CliError(EXIT.usage, 'one of --amount-per-cycle or --total, and one of --interval-secs or --frequency')
      const built = await ctx.dca().open({ ...base, ...amount, ...interval } as DcaOpenRequest)
      return writeTx(ctx, built)
    },
  },
  {
    path: ['dca', 'build', 'update'], summary: 'build ONE unsigned transaction that pauses, resumes or re-floors a position', access: 'keyless',
    options: { owner: { type: 'string', value: '<pubkey>', help: 'the owner' }, position: { type: 'string', value: '<address>', help: 'the position' }, pause: { type: 'boolean', help: 'pause' }, resume: { type: 'boolean', help: 'resume' }, 'min-out-e6': { type: 'string', value: '<n>', help: 'new floor' }, 'max-price': { type: 'string', value: '<n|null>', help: 'new maximum price; null clears it' }, 'max-slippage-bps': { type: 'string', value: '<n>', help: 'new slippage cap' }, 'tx-out': { type: 'string', value: '<path>', help: 'also write the base64 transaction to this new file' } },
    run: async (ctx) => {
      const o = ctx.str('owner'), p = ctx.str('position')
      if (!o || !p) throw new CliError(EXIT.usage, 'usage: carbium dca build update --owner <pubkey> --position <address> [--pause|--resume] [--min-out-e6 n | --max-price n|null] [--max-slippage-bps n]')
      const mp = ctx.str('max-price')
      return writeTx(ctx, await ctx.dca().update({ owner: o, position: p, ...(ctx.bool('pause') ? { paused: true } : ctx.bool('resume') ? { paused: false } : {}), ...(ctx.str('min-out-e6') ? { minOutE6: ctx.str('min-out-e6') as string } : {}), ...(mp === undefined ? {} : { maxPrice: mp === 'null' ? null : mp }), ...(num(ctx, 'max-slippage-bps') === undefined ? {} : { maxSlippageBps: num(ctx, 'max-slippage-bps') as number }) }))
    },
  },
  {
    path: ['dca', 'build', 'withdraw'], summary: 'build ONE unsigned transaction that withdraws from the escrow (0 = all)', access: 'keyless',
    options: { owner: { type: 'string', value: '<pubkey>', help: 'the owner' }, position: { type: 'string', value: '<address>', help: 'the position' }, amount: { type: 'string', value: '<base units>', help: '0 withdraws the whole escrow' }, 'tx-out': { type: 'string', value: '<path>', help: 'also write the base64 transaction to this new file' } },
    run: async (ctx) => {
      const o = ctx.str('owner'), p = ctx.str('position'), a = ctx.str('amount')
      if (!o || !p || a === undefined) throw new CliError(EXIT.usage, 'usage: carbium dca build withdraw --owner <pubkey> --position <address> --amount <n>')
      return writeTx(ctx, await ctx.dca().withdraw({ owner: o, position: p, amount: a }))
    },
  },
  {
    path: ['dca', 'build', 'close'], summary: 'build ONE unsigned transaction that closes a position', access: 'keyless',
    options: { owner: { type: 'string', value: '<pubkey>', help: 'the owner' }, position: { type: 'string', value: '<address>', help: 'the position' }, 'tx-out': { type: 'string', value: '<path>', help: 'also write the base64 transaction to this new file' } },
    run: async (ctx) => {
      const o = ctx.str('owner'), p = ctx.str('position')
      if (!o || !p) throw new CliError(EXIT.usage, 'usage: carbium dca build close --owner <pubkey> --position <address>')
      return writeTx(ctx, await ctx.dca().close({ owner: o, position: p }))
    },
  },
])

async function writeTx<T extends { txn_base64: string; last_valid_block_height: string }>(ctx: Ctx, built: T): Promise<T> {
  const out = ctx.str('tx-out')
  if (out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(out, built.txn_base64 + '\n', { flag: 'wx' })
    ctx.err(`unsigned transaction written to ${out}; sign it with your wallet and send it before block height ${built.last_valid_block_height}`)
  }
  return built
}
