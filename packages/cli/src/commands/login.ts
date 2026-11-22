import { createPublicKey, verify } from 'node:crypto'
import { CarbiumAccount, CarbiumSession, isCarbiumError, type ProofOfWork, type SessionResult } from '@carbium/sdk'
import { base58Decode, decodeSignature } from '../base58.ts'
import { KEY_PREFIX_LEN } from '../config.ts'
import { CliError, EXIT, register, type Ctx } from '../main.ts'

const PREFIX = (k: string): string => k.slice(0, KEY_PREFIX_LEN)

async function acceptTerms(ctx: Ctx): Promise<string> {
  const terms = await CarbiumSession.terms(ctx.sessionOptions())
  // an empty version: no Terms are asked, and '' goes back as the terms_version
  if (terms.version && !ctx.bool('accept-terms')) {
    ctx.err(`Carbium Terms version ${terms.version}${terms.url ? `: ${terms.url}` : ''}`)
    const a = await ctx.prompt('Accept the Terms? [y/N] ')
    if (!/^y(es)?$/i.test(a.trim())) throw new CliError(EXIT.confirm, 'the Terms were not accepted; pass --accept-terms once you have read them')
  }
  return terms.version
}

async function solvePow(ctx: Ctx): Promise<ProofOfWork> {
  const { solveProofOfWork } = await import('../pow.ts')
  const { challenge, difficulty } = await CarbiumSession.signupChallenge(ctx.sessionOptions())
  ctx.err(`solving the sign-up proof of work (${difficulty} bits, about a second)`)
  return { challenge, nonce: solveProofOfWork(challenge, difficulty) }
}

/** With the session: revoke the account key this CLI made before, mint a new one, store it, and store the first service key's secret. */
async function finishLogin(ctx: Ctx, session: SessionResult): Promise<Record<string, unknown>> {
  const s = new CarbiumSession(session.session_token, ctx.sessionOptions())
  ctx.rememberSecret(session.session_token)
  const full = ctx.bool('full')
  const previous = ctx.profile.accountKey
  if (previous?.madeByCli && previous.apiKeyId !== undefined) await s.revokeAccountApiKey(previous.apiKeyId).catch(() => undefined)
  const made = await s.createAccountApiKey({ name: 'carbium-cli', access: full ? 'full' : 'read', expires_in_days: 90 })
  ctx.rememberSecret(made.raw_key)
  ctx.profile.accountKey = { value: made.raw_key, prefix: PREFIX(made.raw_key), access: made.access, apiKeyId: made.api_key_id, expiresAt: made.expires_at, madeByCli: true }
  ctx.profile.writes = full
  let serviceKey: string | null = null
  try {
    const keys = await s.listKeys()
    const live = keys.find((k) => k.revoked_at === null && k.status === 'active') ?? keys[0]
    if (live) {
      const secret = await s.revealKeySecret(live.key_id)
      if (secret.available && secret.raw_key) {
        ctx.rememberSecret(secret.raw_key)
        ctx.profile.serviceKeys = { ...ctx.profile.serviceKeys, default: { value: secret.raw_key, prefix: PREFIX(secret.raw_key), keyId: live.key_id, scope: live.scope } }
        ctx.profile.defaultServiceKey ??= 'default'
        serviceKey = PREFIX(secret.raw_key)
      }
    }
  } catch (e) {
    ctx.err(`service key not stored: ${e instanceof Error ? e.message : String(e)}`)
  }
  ctx.store.save()
  return { account: session.account.account_id, tier: session.account.tier, accountKey: { prefix: ctx.profile.accountKey.prefix, access: made.access, expiresAt: made.expires_at }, serviceKey, writes: full, stored: ctx.store.file }
}

register([
  {
    path: ['login'], summary: 'sign in: --key (paste an account key), --email <address> (PIN by mail) or --wallet <pubkey> (sign a message with your own wallet)', access: 'keyless',
    options: {
      key: { type: 'boolean', help: 'paste an account API key (c_acct_…) at a hidden prompt, or pipe it on stdin' },
      email: { type: 'string', value: '<address>', help: 'sign in or sign up by emailed 6-digit code' },
      wallet: { type: 'string', value: '<pubkey>', help: 'sign in or sign up with a Solana wallet: the CLI prints a message, you sign it with your wallet and paste the signature' },
      full: { type: 'boolean', help: 'a full-access account key, so write commands work (default: read-only)' },
      'accept-terms': { type: 'boolean', help: 'you have read and accept the Carbium Terms (shown otherwise)' },
    },
    run: async (ctx) => {
      const email = ctx.str('email')
      const wallet = ctx.str('wallet')
      if (ctx.bool('key')) {
        const key = (await ctx.prompt('Account API key (c_acct_…, not shown): ', true)).trim()
        ctx.rememberSecret(key)
        if (!/^c_acct_[A-Za-z0-9]{5,}$/.test(key)) throw new CliError(EXIT.usage, 'that is not an account API key (c_acct_…); a service key goes in carbium keys save <name>')
        const acct = new CarbiumAccount({ apiKey: key, baseUrl: ctx.dashboard(), ...(ctx.io.fetch ? { fetch: ctx.io.fetch } : {}) })
        const me = await acct.self()
        if (ctx.bool('full') && me.access !== 'full') throw new CliError(EXIT.auth, `this key has access ${me.access}; --full needs a full-access key`)
        ctx.profile.accountKey = { value: key, prefix: PREFIX(key), access: me.access, apiKeyId: me.api_key_id, expiresAt: me.expires_at, madeByCli: false }
        ctx.profile.writes = ctx.bool('full') && me.access === 'full'
        ctx.store.save()
        return { accountKey: { prefix: me.prefix.slice(0, KEY_PREFIX_LEN), access: me.access, scopes: me.scopes, expiresAt: me.expires_at }, writes: ctx.profile.writes, stored: ctx.store.file }
      }
      if (email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError(EXIT.usage, 'that is not an email address')
        const terms_version = await acceptTerms(ctx)
        const pow = await solvePow(ctx) // a new address needs it, or nothing is mailed; an existing one ignores it
        const { pin_token } = await CarbiumSession.pinStart({ email, terms_version, pow }, ctx.sessionOptions())
        ctx.err(`a 6-digit code was mailed to ${email} (valid 10 minutes)`)
        for (let tries = 0; ; tries++) {
          const code = (await ctx.prompt('Code: ')).trim()
          if (!/^\d{6}$/.test(code)) {
            ctx.err('the code is 6 digits')
            continue
          }
          try {
            return await finishLogin(ctx, await CarbiumSession.pinVerify({ pin_token, code, terms_version }, ctx.sessionOptions()))
          } catch (e) {
            if (isCarbiumError(e) && e.httpStatus === 401 && tries < 2) {
              ctx.err('wrong or expired code; try again')
              continue
            }
            throw e
          }
        }
      }
      if (wallet) {
        let pub: Uint8Array
        try {
          pub = base58Decode(wallet)
        } catch {
          pub = new Uint8Array()
        }
        if (pub.length !== 32) throw new CliError(EXIT.usage, 'the wallet must be a base58 32-byte public key')
        const { nonce_token, message } = await CarbiumSession.walletChallenge(wallet, ctx.sessionOptions())
        ctx.err('Sign this message with your wallet (its exact UTF-8 bytes; a browser wallet\'s signMessage, or @solana/kit signBytes in your own script; `solana sign-offchain-message` does NOT match) and paste the base58 or base64 signature:\n')
        ctx.out(message)
        ctx.err('')
        const sigText = (await ctx.prompt('Signature: ')).trim()
        let sig: Uint8Array
        try {
          sig = decodeSignature(sigText)
        } catch {
          throw new CliError(EXIT.usage, 'the signature must be base58 or padded base64')
        }
        if (sig.length !== 64) throw new CliError(EXIT.usage, `the signature must be 64 bytes, got ${sig.length}`)
        const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pub)])
        if (!verify(null, Buffer.from(message, 'utf8'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sig))) {
          throw new CliError(EXIT.usage, 'that signature does not verify over the message bytes for this wallet; sign the raw message, not an off-chain envelope')
        }
        const signature = sigText
        let result: SessionResult
        try {
          result = await CarbiumSession.walletVerify({ wallet, nonce_token, signature }, ctx.sessionOptions())
        } catch (e) {
          if (!(isCarbiumError(e) && e.httpStatus === 400 && /proof of work required/.test(e.message))) throw e
          const pow = await solvePow(ctx)
          result = await CarbiumSession.walletVerify({ wallet, nonce_token, signature, pow }, ctx.sessionOptions())
        }
        return finishLogin(ctx, result)
      }
      throw new CliError(EXIT.usage, 'usage: carbium login --key | --email <address> | --wallet <pubkey>  [--full] [--accept-terms]')
    },
  },
  {
    path: ['logout'], summary: 'forget the stored keys of this profile (an account key made by the CLI is revoked at the next login or on the ACCOUNT page)', access: 'local',
    run: async (ctx) => {
      const had = { accountKey: ctx.profile.accountKey?.prefix ?? null, apiKeyId: ctx.profile.accountKey?.apiKeyId ?? null, serviceKeys: Object.keys(ctx.profile.serviceKeys ?? {}) }
      delete ctx.profile.accountKey
      delete ctx.profile.serviceKeys
      delete ctx.profile.defaultServiceKey
      ctx.profile.writes = false
      ctx.store.save()
      return { forgot: had, note: had.apiKeyId ? 'the account API key still exists on the account: revoke it on the carbium.sh ACCOUNT page, or sign in again and it is replaced' : undefined }
    },
  },
  {
    path: ['whoami'], summary: 'this account key: access, scopes, expiry, plus the account and its balance', access: 'account', options: { activity: { type: 'boolean', help: 'also the key\'s own activity log' }, limit: { type: 'string', value: '<n>', help: 'activity lines (default 50)' } },
    run: async (ctx) => {
      const me = await ctx.self()
      const acct = ctx.account()
      const [account, balance] = await Promise.all([acct.account.get().catch(() => null), acct.account.balance().catch(() => null)])
      const out: Record<string, unknown> = { key: { prefix: me.prefix.slice(0, KEY_PREFIX_LEN), name: me.name, access: me.access, scopes: me.scopes, expiresAt: me.expires_at, lastUsedAt: me.last_used_at }, account, balance, writes: Boolean(ctx.profile.writes || ctx.flags.allowWrites) }
      if (me.expires_at && Date.parse(me.expires_at) - Date.now() < 7 * 86400_000) ctx.err(`this account key expires at ${me.expires_at}`)
      if (ctx.bool('activity')) out['activity'] = await acct.activity(me.api_key_id, { limit: Number(ctx.str('limit') ?? 50) })
      return out
    },
  },
  {
    path: ['keys', 'save'], summary: 'store a service key you already have (pasted at a hidden prompt or piped on stdin) under a name', usage: '<name>', access: 'local', options: { default: { type: 'boolean', help: 'make it the default service key' } },
    run: async (ctx) => {
      const name = ctx.positionals[0]
      if (!name) throw new CliError(EXIT.usage, 'usage: carbium keys save <name>')
      const key = (await ctx.prompt('Service key (c_serv_…, not shown): ', true)).trim()
      ctx.rememberSecret(key)
      if (!/^c_serv_[A-Za-z0-9]{5,}$/.test(key)) throw new CliError(EXIT.usage, 'that is not a service key (c_serv_…)')
      ctx.profile.serviceKeys = { ...ctx.profile.serviceKeys, [name]: { value: key, prefix: PREFIX(key) } }
      if (ctx.bool('default') || !ctx.profile.defaultServiceKey) ctx.profile.defaultServiceKey = name
      ctx.store.save()
      return { name, prefix: PREFIX(key), default: ctx.profile.defaultServiceKey === name }
    },
  },
])

/**
 * Stores a raw service key under a name, and into the 0600 file reserved before the service call; never prints it.
 * The profile is written first, so a failed file write after the service acted never loses the only copy.
 */
export function storeServiceKey(ctx: Ctx, raw: string, keyId: number, scope: string[] | undefined, saveAs: string | undefined, secret: { path: string; file: { write(value: string): void } } | undefined): Record<string, unknown> {
  ctx.rememberSecret(raw)
  const where: Record<string, unknown> = { prefix: PREFIX(raw), keyId }
  const name = saveAs ?? (secret ? undefined : `key-${keyId}`)
  if (name) {
    ctx.profile.serviceKeys = { ...ctx.profile.serviceKeys, [name]: { value: raw, prefix: PREFIX(raw), keyId, ...(scope ? { scope } : {}) } }
    ctx.profile.defaultServiceKey ??= name
    ctx.store.save()
    where['savedAs'] = name
    where['default'] = ctx.profile.defaultServiceKey === name
  }
  if (secret) {
    try {
      secret.file.write(raw)
      where['secretFile'] = secret.path
    } catch (e) {
      if (!name) throw new CliError(EXIT.service, `key ${keyId}: its new value could not be written to ${secret.path} (${(e as Error).message}) and is not shown`, `make a new value: carbium keys rotate ${keyId} --secret-file <new path>`)
      ctx.err(`carbium: --secret-file ${secret.path} could not be written (${(e as Error).message}); the key is stored in the profile as ${name}`)
    }
  }
  return where
}
