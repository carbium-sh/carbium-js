/**
 * Client for the account API on carbium.sh: service keys, webhooks and usage.
 * @module
 */
import { CarbiumError } from './errors.ts'
import { httpJson, retryAfterHeaderMs, type HttpAnswer } from './http.ts'
import type { Account, AccountApiKey, AccountApiKeyActivity, Balance, CreatedKey, CreatedWebhook, CreateWebhookRequest, CryptoIntent, DailyUsageRow, HourlyUsageRow, Invoice, KeyLimits, KeyLimitsView, KeyLoad, KeyScope, KeysUsage, LatencyRow, MethodCap, MethodCapView, ModuleInfo, Payment, Plans, RotatedKey, RotatedWebhookSecret, ServiceKey, UpdateWebhookRequest, Webhook, WebhookDelivery, WebhookTestResult } from './account-types.ts'

export interface AccountOptions {
  /** An account API key, c_acct_… (made on the dashboard). Never a service key. */
  apiKey: string
  /** Default https://carbium.sh */
  baseUrl?: string
  fetch?: typeof fetch
  /** Default 30 000. */
  timeoutMs?: number
}

interface Signal {
  signal?: AbortSignal
}

function accountError(a: HttpAnswer, method: string): CarbiumError {
  const body = typeof a.json === 'object' && a.json !== null ? (a.json as Record<string, unknown>) : {}
  const code = typeof body['error'] === 'string' ? body['error'] : null
  const hint = retryAfterHeaderMs(a.headers)
  const rid = a.headers.get('x-request-id')
  return new CarbiumError({
    kind: 'account',
    method,
    httpStatus: a.status,
    code,
    message: typeof body['message'] === 'string' ? body['message'] : a.text.trim().slice(0, 200) || `HTTP ${a.status}`,
    retryable: a.status === 503,
    ...(hint === undefined ? {} : { retryAfterMs: hint }),
    ...(rid ? { requestId: rid } : {}),
    data: body,
  })
}

/**
 * The account API at carbium.sh/v1 with an account API key: service keys, webhooks, usage and the account's
 * records. No call costs credits; 600 calls per 10 minutes per key. The SDK never retries here, because creates
 * are not safe to repeat: a 429 comes back with retryAfterMs.
 */
export class CarbiumAccount {
  readonly baseUrl: string
  readonly #apiKey: string
  readonly #http: { fetch?: typeof fetch; timeoutMs?: number }

  constructor(options: AccountOptions) {
    if (!/^c_acct_[A-Za-z0-9]+$/.test(options.apiKey)) throw new CarbiumError({ kind: 'auth', message: 'apiKey must be an account API key (c_acct_…) from the dashboard; a service key (c_serv_) is for services.carbium.sh' })
    this.baseUrl = (options.baseUrl ?? 'https://carbium.sh').replace(/\/$/, '')
    this.#apiKey = options.apiKey
    this.#http = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }
  }

  async #call<T>(method: string, httpMethod: string, path: string, body?: unknown, options: Signal & { timeoutMs?: number } = {}): Promise<T> {
    const a = await httpJson(this.baseUrl + path, { method: httpMethod, headers: { authorization: `Bearer ${this.#apiKey}` }, ...(body === undefined ? {} : { body }) }, { ...this.#http, ...options }, 'account')
    if (a.status >= 400) throw accountError(a, method)
    return a.json as T
  }

  static #query(params: Record<string, unknown>): string {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.set(k, String(v))
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  /** Service keys: keys:read and keys:write. */
  readonly keys = {
    /** GET /v1/keys: every key's record, never its value. */
    list: (o: Signal = {}): Promise<ServiceKey[]> => this.#call('keys.list', 'GET', '/v1/keys', undefined, o),
    /** POST /v1/keys: a new service key; raw_key is shown once. */
    create: (req: { name?: string; scope?: KeyScope[] } = {}, o: Signal = {}): Promise<CreatedKey> => this.#call('keys.create', 'POST', '/v1/keys', req, o),
    /** POST /v1/keys/{id}/rotate: a new raw key for the same record. */
    rotate: (id: number, o: Signal = {}): Promise<RotatedKey> => this.#call('keys.rotate', 'POST', `/v1/keys/${id}/rotate`, undefined, o),
    /** POST /v1/keys/{id}/revoke */
    revoke: (id: number, o: Signal = {}): Promise<{ applied: boolean }> => this.#call('keys.revoke', 'POST', `/v1/keys/${id}/revoke`, undefined, o),
    /** DELETE /v1/keys/{id} */
    delete: (id: number, o: Signal = {}): Promise<{ deleted: boolean }> => this.#call('keys.delete', 'DELETE', `/v1/keys/${id}`, undefined, o),
    /** POST /v1/keys/{id}/name; "" clears it. */
    rename: (id: number, name: string, o: Signal = {}): Promise<{ name: string | null }> => this.#call('keys.rename', 'POST', `/v1/keys/${id}/name`, { name }, o),
    /** PATCH /v1/keys/{id}/scope: at least one plane. */
    setScope: (id: number, scope: KeyScope[], o: Signal = {}): Promise<{ key_id: number; scope: KeyScope[] }> => this.#call('keys.setScope', 'PATCH', `/v1/keys/${id}/scope`, { scope }, o),
    /** PATCH /v1/keys/{id}/caps: per-method-class ceilings; [] clears them. */
    setCaps: (id: number, per_method_caps: MethodCap[], o: Signal = {}): Promise<MethodCapView[]> => this.#call('keys.setCaps', 'PATCH', `/v1/keys/${id}/caps`, { per_method_caps }, o),
    /** PATCH /v1/keys/{id}/allowlist: at most 16 entries. */
    setAllowlist: (id: number, ip_allow: string[], o: Signal = {}): Promise<{ key_id: number; ip_allow: string[] }> => this.#call('keys.setAllowlist', 'PATCH', `/v1/keys/${id}/allowlist`, { ip_allow }, o),
    /** PATCH /v1/keys/{id}/limits: connections and in-flight calls, 0 to 10000 each; 0, null or left out is the plan's own number. Both are replaced together. */
    setLimits: (id: number, limits: KeyLimits, o: Signal = {}): Promise<KeyLimitsView> => this.#call('keys.setLimits', 'PATCH', `/v1/keys/${id}/limits`, limits, o),
  }

  /** Webhooks: webhooks:read and webhooks:write. DEV plan and above. */
  readonly webhooks = {
    /** GET /v1/webhooks */
    list: (o: Signal = {}): Promise<Webhook[]> => this.#call('webhooks.list', 'GET', '/v1/webhooks', undefined, o),
    /** GET /v1/webhooks/{id}, with its addresses. */
    get: (id: number, o: Signal = {}): Promise<Webhook> => this.#call('webhooks.get', 'GET', `/v1/webhooks/${id}`, undefined, o),
    /** GET /v1/webhooks/{id}/deliveries: the log, newest first; before is a line's cursor or a Unix-ms time. */
    deliveries: (id: number, q: { limit?: number; before?: string | number } = {}, o: Signal = {}): Promise<WebhookDelivery[]> => this.#call('webhooks.deliveries', 'GET', `/v1/webhooks/${id}/deliveries${CarbiumAccount.#query(q)}`, undefined, o),
    /** POST /v1/webhooks: the secret is shown once. */
    create: (req: CreateWebhookRequest, o: Signal = {}): Promise<CreatedWebhook> => this.#call('webhooks.create', 'POST', '/v1/webhooks', req, o),
    /** PATCH /v1/webhooks/{id}: any create field, or status paused | active. */
    update: (id: number, req: UpdateWebhookRequest, o: Signal = {}): Promise<Webhook> => this.#call('webhooks.update', 'PATCH', `/v1/webhooks/${id}`, req, o),
    /** DELETE /v1/webhooks/{id} */
    delete: (id: number, o: Signal = {}): Promise<{ deleted: boolean }> => this.#call('webhooks.delete', 'DELETE', `/v1/webhooks/${id}`, undefined, o),
    /** POST /v1/webhooks/{id}/rotate: the old secret still signs until previous_valid_until. */
    rotateSecret: (id: number, o: Signal = {}): Promise<RotatedWebhookSecret> => this.#call('webhooks.rotateSecret', 'POST', `/v1/webhooks/${id}/rotate`, undefined, o),
    /** POST /v1/webhooks/{id}/test: one signed test event, tried once within 15 s. Read outcome, not the HTTP status. */
    test: (id: number, o: Signal = {}): Promise<WebhookTestResult> => this.#call('webhooks.test', 'POST', `/v1/webhooks/${id}/test`, undefined, { ...o, timeoutMs: Math.max(this.#http.timeoutMs ?? 30_000, 25_000) }),
  }

  /** Usage: usage:read. */
  readonly usage = {
    /** GET /v1/usage: per UTC day and method; from and to as YYYY-MM-DD, at most 90 days. */
    daily: (q: { from?: string; to?: string; key_id?: number; group?: 'key' } = {}, o: Signal = {}): Promise<DailyUsageRow[]> => this.#call('usage.daily', 'GET', `/v1/usage${CarbiumAccount.#query(q)}`, undefined, o),
    /** GET /v1/keys/usage: this period's credits per key. */
    perKey: (o: Signal = {}): Promise<KeysUsage> => this.#call('usage.perKey', 'GET', '/v1/keys/usage', undefined, o),
    /** GET /v1/keys/load: current requests per second per key. */
    load: (o: Signal = {}): Promise<KeyLoad[]> => this.#call('usage.load', 'GET', '/v1/keys/load', undefined, o),
    /** GET /v1/usage/hourly: RFC 3339 from and to, at most 7 days. */
    hourly: (q: { from?: string; to?: string; key_id?: number } = {}, o: Signal = {}): Promise<HourlyUsageRow[]> => this.#call('usage.hourly', 'GET', `/v1/usage/hourly${CarbiumAccount.#query(q)}`, undefined, o),
    /** GET /v1/usage/latency: p50, p95 and p99 per hour and method class. */
    latency: (q: { from?: string; to?: string; key_id?: number } = {}, o: Signal = {}): Promise<LatencyRow[]> => this.#call('usage.latency', 'GET', `/v1/usage/latency${CarbiumAccount.#query(q)}`, undefined, o),
  }

  /** The account's records: account:read. */
  readonly account = {
    /** GET /v1/account */
    get: (o: Signal = {}): Promise<Account> => this.#call('account.get', 'GET', '/v1/account', undefined, o),
    /** GET /v1/balance: credits granted, used and remaining. */
    balance: (o: Signal = {}): Promise<Balance> => this.#call('account.balance', 'GET', '/v1/balance', undefined, o),
    /** GET /v1/invoices */
    invoices: (o: Signal = {}): Promise<Invoice[]> => this.#call('account.invoices', 'GET', '/v1/invoices', undefined, o),
    /** GET /v1/payments */
    payments: (o: Signal = {}): Promise<Payment[]> => this.#call('account.payments', 'GET', '/v1/payments', undefined, o),
    /** GET /v1/modules: every module with its plans and what the account holds. */
    modules: (o: Signal = {}): Promise<ModuleInfo[]> => this.#call('account.modules', 'GET', '/v1/modules', undefined, o),
    /** GET /v1/billing/crypto-intent/{id}: the state of a crypto payment intent made on the dashboard or by an agent session. */
    cryptoIntent: (id: number, o: Signal = {}): Promise<CryptoIntent> => this.#call('account.cryptoIntent', 'GET', `/v1/billing/crypto-intent/${id}`, undefined, o),
  }

  /** Modules: modules:write. */
  readonly modules = {
    /** POST /v1/modules/{module}: enables a free plan, for example enableFree('quote', 'free'). Paid plans are bought on the dashboard. */
    enableFree: (module: string, plan?: string, o: Signal = {}): Promise<ModuleInfo> => this.#call('modules.enableFree', 'POST', `/v1/modules/${encodeURIComponent(module)}`, plan === undefined ? {} : { plan }, o),
  }

  /** GET /v1/api-key: this account API key's own record. */
  self(o: Signal = {}): Promise<AccountApiKey> {
    return this.#call('self', 'GET', '/v1/api-key', undefined, o)
  }

  /** GET /v1/account/api-keys/{id}/activity: this key's own activity log (another key's id answers 404). */
  activity(id: number, q: { limit?: number; before?: number } = {}, o: Signal = {}): Promise<AccountApiKeyActivity[]> {
    return this.#call('activity', 'GET', `/v1/account/api-keys/${id}/activity${CarbiumAccount.#query(q)}`, undefined, o)
  }
}

// Session calls: the dashboard routes that take no key, or a session token. They never hold a private key: the
// wallet sign-in message is signed by the user's own wallet and the signature is passed in.

export interface SessionOptions {
  /** Default https://carbium.sh */
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}
/** GET /v1/terms: the current Terms version and link. An empty version means no Terms are asked. */
export interface Terms {
  version: string
  url: string
}
/** GET /v1/signup/challenge: solve BLAKE3(challenge UTF-8 || nonce as 8 little-endian bytes) with `difficulty` leading zero bits. */
export interface SignupChallenge {
  challenge: string
  difficulty: number
}
export interface ProofOfWork {
  challenge: string
  nonce: number
}
export interface SessionAccount {
  account_id: number
  email: string | null
  wallet: string | null
  status: string
  created_at: string
  tier: string
  [extra: string]: unknown
}
export interface SessionResult {
  session_token: string
  account: SessionAccount
}

function baseOf(options: SessionOptions): string {
  return (options.baseUrl ?? 'https://carbium.sh').replace(/\/$/, '')
}

async function open<T>(method: string, httpMethod: string, path: string, body: unknown, options: SessionOptions, bearer?: string): Promise<T> {
  const headers: Record<string, string> = bearer ? { authorization: `Bearer ${bearer}` } : {}
  const a = await httpJson(baseOf(options) + path, { method: httpMethod, headers, ...(body === undefined ? {} : { body }) }, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, 'account')
  if (a.status >= 400) throw accountError(a, method)
  return a.json as T
}

/**
 * A dashboard session on carbium.sh: made by an emailed PIN or a wallet signature, held in memory only. A session can
 * mint account API keys and reveal a service key's secret once; it is never stored by the SDK.
 */
export class CarbiumSession {
  readonly #token: string
  readonly #options: SessionOptions

  constructor(sessionToken: string, options: SessionOptions = {}) {
    if (!sessionToken) throw new CarbiumError({ kind: 'auth', message: 'a session token is required' })
    this.#token = sessionToken
    this.#options = options
  }

  /** GET /v1/terms: an empty version means no Terms are asked. */
  static async terms(options: SessionOptions = {}): Promise<Terms> {
    const t = await open<Partial<Terms>>('terms', 'GET', '/v1/terms', undefined, options)
    if (typeof t.version !== 'string') throw new CarbiumError({ kind: 'account', method: 'terms', message: 'GET /v1/terms answered without a version' })
    return { version: t.version, url: typeof t.url === 'string' ? t.url : '' }
  }

  /** GET /v1/plans (public): every plan's tier or name, price in US cents a month, whether it is sold, and its credit grant. */
  static plans(options: SessionOptions = {}): Promise<Plans> {
    return open('plans', 'GET', '/v1/plans', undefined, options)
  }

  /** GET /v1/signup/challenge: good for 300 s, opens one account at most. */
  static signupChallenge(options: SessionOptions = {}): Promise<SignupChallenge> {
    return open('signupChallenge', 'GET', '/v1/signup/challenge', undefined, options)
  }

  /** POST /v1/login/pin: mails a 6-digit code. A new address also needs a proof of work, or nothing is mailed. */
  static pinStart(request: { email: string; terms_version: string; pow?: ProofOfWork }, options: SessionOptions = {}): Promise<{ pin_token: string }> {
    return open('pinStart', 'POST', '/v1/login/pin', request, options)
  }

  /** POST /v1/login/pin/verify: the code from the mail, valid 10 minutes. */
  static pinVerify(request: { pin_token: string; code: string; terms_version: string }, options: SessionOptions = {}): Promise<SessionResult> {
    return open('pinVerify', 'POST', '/v1/login/pin/verify', request, options)
  }

  /** POST /v1/auth/wallet step challenge: the message the user's own wallet signs (its UTF-8 bytes, ed25519). */
  static walletChallenge(wallet: string, options: SessionOptions = {}): Promise<{ nonce_token: string; message: string }> {
    return open('walletChallenge', 'POST', '/v1/auth/wallet', { step: 'challenge', wallet }, options)
  }

  /** POST /v1/auth/wallet step verify: the 64-byte signature in base58 or padded base64; a first sign-in also needs the proof of work. */
  static walletVerify(request: { wallet: string; nonce_token: string; signature: string; pow?: ProofOfWork; terms_version?: string }, options: SessionOptions = {}): Promise<SessionResult> {
    return open('walletVerify', 'POST', '/v1/auth/wallet', { step: 'verify', ...request }, options)
  }

  /** POST /v1/account/api-keys: a new account API key; raw_key is shown once. At most 5 live per account. */
  createAccountApiKey(request: { name: string; access: 'full' | 'read'; expires_in_days?: 30 | 90 | 365 | null; ip_allow?: string[] }): Promise<AccountApiKey & { raw_key: string }> {
    return open('createAccountApiKey', 'POST', '/v1/account/api-keys', request, this.#options, this.#token)
  }

  /** GET /v1/account/api-keys: the live account API keys, newest first. */
  listAccountApiKeys(): Promise<AccountApiKey[]> {
    return open('listAccountApiKeys', 'GET', '/v1/account/api-keys', undefined, this.#options, this.#token)
  }

  /** DELETE /v1/account/api-keys/{id} */
  revokeAccountApiKey(id: number): Promise<{ api_key_id: number; revoked: boolean }> {
    return open('revokeAccountApiKey', 'DELETE', `/v1/account/api-keys/${id}`, undefined, this.#options, this.#token)
  }

  /** GET /v1/keys with the session. */
  listKeys(): Promise<ServiceKey[]> {
    return open('listKeys', 'GET', '/v1/keys', undefined, this.#options, this.#token)
  }

  /** POST /v1/keys/{id}/secret: a service key's value, shown again to a session only. */
  revealKeySecret(keyId: number): Promise<{ available: boolean; raw_key?: string }> {
    return open('revealKeySecret', 'POST', `/v1/keys/${keyId}/secret`, undefined, this.#options, this.#token)
  }

  /** POST /v1/modules/{module}: a free plan, for example the free Quote plan; {} takes the cheapest. */
  enableModule(module: string, plan?: string): Promise<ModuleInfo> {
    return open('enableModule', 'POST', `/v1/modules/${encodeURIComponent(module)}`, plan === undefined ? {} : { plan }, this.#options, this.#token)
  }

  /** DELETE /v1/modules/{module}: remove a module from the account. */
  disableModule(module: string): Promise<ModuleInfo> {
    return open('disableModule', 'DELETE', `/v1/modules/${encodeURIComponent(module)}`, undefined, this.#options, this.#token)
  }

  /** POST /v1/account/link-wallet step nonce: the message the wallet to link signs (its UTF-8 bytes, ed25519). */
  linkWalletChallenge(wallet: string): Promise<{ nonce_token: string; message: string }> {
    return open('linkWalletChallenge', 'POST', '/v1/account/link-wallet', { step: 'nonce', wallet }, this.#options, this.#token)
  }

  /** POST /v1/account/link-wallet step link: links the wallet; the answer carries a new session token and every old session ends. */
  linkWallet(request: { wallet: string; nonce_token: string; signature: string; pow?: ProofOfWork; terms_version?: string }): Promise<SessionAccount & { session_token: string }> {
    return open('linkWallet', 'POST', '/v1/account/link-wallet', { step: 'link', ...request }, this.#options, this.#token)
  }

  /** POST /v1/logout: ends every session of the account. */
  async logout(): Promise<void> {
    await open('logout', 'POST', '/v1/logout', undefined, this.#options, this.#token)
  }
}
