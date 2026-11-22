export type KeyScope = 'rpc' | 'ws' | 'grpc' | 'quote' | 'das'
export type KeyStatus = 'active' | 'suspended' | 'revoked' | 'disabled' | (string & {})
export type MethodClass = 'o1_cached' | 'bounded_read' | 'bounded_slot' | 'write_send' | 'compute' | 'bounded_disk' | 'range' | 'scan' | 'gpa' | 'das'

export interface ServiceKey {
  key_id: number
  prefix: string | null
  name: string | null
  tier: string
  scope: KeyScope[]
  status: KeyStatus
  per_method_caps: MethodCapView[]
  max_connections: number | null
  max_inflight: number | null
  ip_allow: string[]
  created_at: string | null
  rotated_at: string | null
  revoked_at: string | null
  [extra: string]: unknown
}
/** A per-method-class cap to set; the whole list is replaced. */
export interface MethodCap {
  method_class: MethodClass
  rps_ceiling?: number
  allow?: boolean
}
/** A per-method-class cap as stored. */
export interface MethodCapView {
  method_class: string
  rps_ceiling: number
  allow: boolean
}
/** Connection and in-flight limits; 0 or left out is the plan's own number, and both are replaced together. */
export interface KeyLimits {
  max_connections?: number | null
  max_inflight?: number | null
}
export interface KeyLimitsView {
  max_connections: number | null
  max_inflight: number | null
}
/** The raw key is shown once: store it. */
export interface CreatedKey {
  key_id: number
  prefix: string
  raw_key: string
  name: string | null
}
export interface RotatedKey {
  prefix: string
  raw_key: string
}

export type WebhookStatus = 'active' | 'paused' | 'disabled'
export interface Webhook {
  webhook_id: number
  key_id: number | null
  name: string | null
  url: string
  status: WebhookStatus
  status_reason: string | null
  tx_status: 'all' | 'success' | 'failed'
  address_count: number
  /** Present on a single read only. */
  addresses?: string[]
  secret_hint: string
  has_auth_header: boolean
  consecutive_failures: number
  last_success_at: string | null
  last_failure_at: string | null
  created_at: string
  updated_at: string
  [extra: string]: unknown
}
export interface CreateWebhookRequest {
  /** The service key whose credits pay the deliveries. */
  key_id: number
  /** https on port 443 at a public host name, at most 2048 characters. */
  url: string
  /** Base58 addresses to watch. */
  addresses: string[]
  name?: string
  tx_status?: 'all' | 'success' | 'failed'
  /** Sent as the Authorization header of every delivery. At most 512 characters. */
  auth_header?: string
}
export interface UpdateWebhookRequest extends Partial<CreateWebhookRequest> {
  status?: 'paused' | 'active'
}
/** The secret is shown once: store it. */
export interface CreatedWebhook {
  webhook: Webhook
  secret: string
}
export interface RotatedWebhookSecret {
  secret: string
  secret_hint: string
  /** Until when the previous secret still signs, about a day. */
  previous_valid_until: string
}
export interface WebhookDelivery {
  ts: number
  event_id: string
  slot: number
  kind: 'delivery' | 'test'
  attempt: number
  outcome: 'delivered' | 'failed' | 'dropped' | 'refused'
  http_status: number
  reason: string
  latency_ms: number
  cursor: string
}
export interface WebhookTestResult {
  event_id: string
  ts: number
  /** delivered, failed or refused; read this, not the HTTP status. */
  outcome: 'delivered' | 'failed' | 'refused' | (string & {})
  http_status: number
  reason: string
  latency_ms: number
  /** credits, rate, plan, key, secret, host or refused, when outcome is refused. */
  refusal: string | null
  [extra: string]: unknown
}

export interface DailyUsageRow {
  utc_day: string
  method: string
  method_class: string
  call_count: number
  credits_charged: number
  /** With group=key; null for calls made before a key was rotated or by a key since deleted. */
  key_id?: number | null
}
export interface KeysUsage {
  period_start: string
  period_end: string
  account_credits: number | null
  keys: Array<{ key_id: number; credits: number; calls: number }>
}
export interface KeyLoad {
  key_id: number
  rps_current: number
  class_rps: Record<string, number>
}
export interface HourlyUsageRow {
  hour: string
  key_id: number | null
  method_class: string
  calls: number
  credits_charged: number
  errors: number
  resp_bytes: number
}
export interface LatencyRow {
  hour: string
  key_id: number | null
  method_class: string
  calls: number
  p50_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}
export interface AccountTerm {
  tier: string
  status: string
  period_start: string
  period_end: string
  cancel_at_period_end: boolean
  auto_renew: boolean
  contract: boolean
  linked: boolean
}
export interface Account {
  account_id: number
  email: string | null
  wallet: string | null
  status: string
  created_at: string
  tier: string
  term: AccountTerm | null
  payments: Payment[]
  [extra: string]: unknown
}
export interface Balance {
  granted: number
  used: number
  remaining: number
}
export interface Invoice {
  period_start: string | null
  period_end: string | null
  granted: number
  used: number
  current: boolean
}
export interface Payment {
  id: number
  amount_minor: number
  currency: string
  status: string
  method: string
  tier: string | null
  module: string | null
  plan: string | null
  months: number | null
  credits_granted: number | null
  reference: string
  payer: string | null
  mint: string | null
  received_at: string
  paid_at: string
  /** Whether GET /v1/payments/{id}/document has a PDF (a session call). */
  document: boolean
  [extra: string]: unknown
}
/** A plan of a module (the quote plane): price in US cents a month and its rate. */
export interface ModulePlan {
  plan: string
  amount_minor: number
  currency: string
  sellable: boolean
  recurring: boolean
  card: boolean
  rps: number
  rpm: number
}
/** A module with its plans and what the account holds. */
export interface ModuleInfo {
  module: string
  label: string
  blurb: string
  available: boolean
  enabled: boolean
  plan: string | null
  plans: ModulePlan[]
  status: string | null
  cancel_at_period_end: boolean | null
  period_start: string | null
  period_end: string | null
  auto_renew: boolean
  contract: boolean
  linked: boolean
  [extra: string]: unknown
}
/** An RPC tier: price in US cents a month and its credit grant. */
export interface Plan {
  tier: string
  amount_minor: number
  currency: string
  period: string
  sellable: boolean
  recurring: boolean
  card: boolean
  credit_grant: number | null
}
export interface Plans {
  plans: Plan[]
  quote: ModulePlan[]
}
/** A crypto payment intent (USDC or USDT on Solana) made by a session; an account key reads its state. */
export interface CryptoIntent {
  intent_id: number
  status: 'open' | 'paid' | 'held' | 'expired'
  recipient: string
  mint: string
  decimals: number
  amount: number
  amount_ui: string
  reference: string
  expiry: string
  expiry_unix: number
  months: number
  amount_minor: number
  currency: string
  solana_pay_url: string
  refused: Array<{ signature: string; reason: string }>
  tier?: string
  module?: string
  plan?: string
  term?: Record<string, unknown>
  signature?: string
  tx?: string
  payer_account?: string
  payer_balance?: number
  sim_error?: string
  [extra: string]: unknown
}
export interface AccountApiKey {
  api_key_id: number
  name: string | null
  prefix: string
  access: 'full' | 'read'
  scopes: string[]
  ip_allow: string[]
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}
export interface AccountApiKeyActivity {
  ts: number
  action: string
  request_id: string | null
  detail: unknown
}
