// The code in the three packages' READMEs: every ts and js block type-checks against the built SDK under the cookbook's
// strict options (tsc), with what the text around it assumes declared from DECLARES; every json block parses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = ['sdk', 'cli', 'mcp']

const C = `import type { Carbium, ResultOf } from '@carbium/sdk'; declare const carbium: Carbium`
/** What each block assumes from the text around it, keyed by the block's first line. The block itself is never edited. */
const DECLARES: Record<string, string> = {
  "import { createCarbium, isCarbiumError } from '@carbium/sdk'": '',
  'const carbium = createCarbium({ apiKey })': `import { createCarbium } from '@carbium/sdk'; declare const apiKey: string, a: string, b: string, mint: string, owner: string`,
  "const q = await carbium.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: '100000000', slippage_bps: 50 })": `${C}; declare const SOL: string, USDC: string`,
  "const quote = await carbium.quote.quote({ src_mint: SOL, dst_mint: USDC, amount_in: '100000000', slippage_bps: 50 })": `${C}; import type { KeyPairSigner } from '@solana/kit'; declare const SOL: string, USDC: string, wallet: KeyPairSigner`,
  "import { getBase64Encoder, getTransactionDecoder, signTransaction, getBase64EncodedWireTransaction } from '@solana/kit'": `${C}; import type { generateKeyPair } from '@solana/kit'; declare const swap: ResultOf<'swap'>, keyPair: Awaited<ReturnType<typeof generateKeyPair>>`,
  "import { VersionedTransaction } from '@solana/web3.js'": `${C}; import type { Keypair } from '@solana/web3.js'; declare const swap: ResultOf<'swap'>, keypair: Keypair`,
  'const socket = carbium.socket({ onReseed: ({ gap }) => reloadStateOverRpc() })': `${C}; declare const pubkey: string; declare function reloadStateOverRpc(): void`,
  "import { CarbiumStream } from '@carbium/sdk/stream'": 'declare const apiKey: string, programId: string; declare function handle(tx: unknown): void; declare function reloadOverRpc(): Promise<void>',
  "import { verifyWebhook } from '@carbium/sdk/webhooks'": `import type { IncomingMessage } from 'node:http'; declare const rawBody: Uint8Array, request: IncomingMessage`,
  "import { CarbiumAccount } from '@carbium/sdk/account'": 'declare const wallet: string',
  "import { CarbiumDca } from '@carbium/sdk/dca'": 'declare const USDC: string, SOL: string, owner: string, signedBase64: string',
  "import { CarbiumTokens } from '@carbium/sdk/tokens'": 'declare const mints: string[], mint: string',
}

interface Block { pkg: string; line: number; lang: string; code: string }

/** Every fenced block of each README; line is the README line of the block's first code line. */
const blocks: Block[] = PACKAGES.flatMap((pkg) => {
  const out: Block[] = []
  let open: Block | undefined
  readFileSync(join(SDK, '..', pkg, 'README.md'), 'utf8').split('\n').forEach((l, i) => {
    const fence = /^```(\w*)\s*$/.exec(l)
    if (!fence) {
      if (open) open.code += l + '\n'
    } else if (open) {
      out.push(open)
      open = undefined
    } else open = { pkg, line: i + 2, lang: fence[1] ?? '', code: '' }
  })
  if (open) throw new Error(`packages/${pkg}/README.md:${open.line - 1}: a fence that never closes (or a fence form this parser does not read before it)`)
  return out
})

test('every ts and js block of the three READMEs type-checks against the built SDK under the cookbook strict options', (t) => {
  const dir = mkdtempSync(join(SDK, 'test', '.readme-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const unused = new Set(Object.keys(DECLARES))
  for (const b of blocks.filter((x) => /^(ts|js|typescript|javascript)$/.test(x.lang))) {
    const first = b.code.split('\n')[0] ?? ''
    const declares = DECLARES[first]
    assert.ok(declares !== undefined, `packages/${b.pkg}/README.md:${b.line} is a block with no DECLARES entry: add one keyed by its first line, ${first}`)
    unused.delete(first)
    writeFileSync(join(dir, `${b.pkg}-${b.line}.ts`), `${declares}\n${b.code}export {}\n`)
  }
  assert.deepEqual([...unused], [], 'DECLARES entries that no README block starts with')
  const compilerOptions = { target: 'es2023', lib: ['es2023'], module: 'nodenext', moduleResolution: 'nodenext', strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, skipLibCheck: true, noEmit: true, types: ['node'] }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['*.ts'] }))
  const r = spawnSync(join(SDK, 'node_modules', '.bin', 'tsc'), ['-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' })
  // file line 1 holds the declares, so file line n is README line (block line + n - 2)
  const out = `${r.stdout}${r.stderr}`.replace(/[^\s(]*\b(\w+)-(\d+)\.ts\((\d+),(\d+)\)/g, (_m, pkg: string, start: string, l: string, c: string) => `packages/${pkg}/README.md:${Number(start) + Number(l) - 2}:${c}`)
  assert.equal(r.status, 0, out || String(r.error))
})

test('every json block of the three READMEs parses', () => {
  const json = blocks.filter((b) => b.lang === 'json')
  assert.ok(json.length > 0, 'no json block found')
  for (const b of json) assert.doesNotThrow(() => JSON.parse(b.code), `packages/${b.pkg}/README.md:${b.line}`)
})
