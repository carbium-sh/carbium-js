/**
 * Webhook signature checks for Carbium webhooks.
 * @module
 */
import { CarbiumError } from './errors.ts'

/** One element of a webhook body: a finalized transaction in the getTransaction shape, a short form over 64 KiB, or the test event. */
export interface WebhookEvent {
  slot: number
  blockTime: number | null
  indexWithinBlock: number
  transaction?: unknown
  meta?: unknown
  version?: 'legacy' | 0 | 1
  signature?: string
  err?: unknown
  status?: unknown
  truncated?: true
  test?: true
  [extra: string]: unknown
}

/** Fetch Headers, or Node's incoming headers object (lower-case names, string or string[] values). */
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>

export interface VerifyWebhookOptions {
  /** How far webhook-timestamp may sit from the clock, in seconds. Default 300. */
  toleranceSeconds?: number
  /** The clock, in Unix seconds. Default Date.now()/1000. */
  now?: () => number
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  // A plain object: Node lowercases names, but AWS Lambda, other hosts and captured dumps keep the sender's case.
  const record = headers as Record<string, string | string[] | undefined>
  let v = record[name]
  if (v === undefined) {
    const want = name.toLowerCase()
    for (const [k, x] of Object.entries(record)) if (k.toLowerCase() === want) { v = x; break }
  }
  return Array.isArray(v) ? v[0] : v
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function fail(reason: string, message: string): CarbiumError {
  return new CarbiumError({ kind: 'webhook', reason, message })
}

/**
 * Checks the Standard Webhooks signature of a delivery and resolves when one entry matches: HMAC-SHA256 with the
 * secret's base64 after whsec_, over `webhook-id.webhook-timestamp.rawBody`, against every `v1,<base64>` entry in
 * webhook-signature (two entries during a secret rotation). Pass the RAW body bytes as received, never a re-encoded
 * JSON string. Throws a CarbiumError of kind 'webhook' with reason missing_header, bad_timestamp, stale, bad_secret
 * or no_match.
 */
export async function verifyWebhookSignature(rawBody: Uint8Array | ArrayBuffer | string, headers: WebhookHeaders, secret: string, options: VerifyWebhookOptions = {}): Promise<Uint8Array> {
  const id = header(headers, 'webhook-id')
  const ts = header(headers, 'webhook-timestamp')
  const sig = header(headers, 'webhook-signature')
  if (!id || !ts || !sig) throw fail('missing_header', 'webhook-id, webhook-timestamp and webhook-signature are all required')
  if (!/^\d+$/.test(ts)) throw fail('bad_timestamp', 'webhook-timestamp must be Unix seconds')
  const tolerance = options.toleranceSeconds ?? 300
  const now = options.now ? options.now() : Date.now() / 1000
  // !(x <= t) also refuses a NaN clock or tolerance: the check fails closed
  if (!(Math.abs(now - Number(ts)) <= tolerance)) throw fail('stale', `webhook-timestamp is more than ${tolerance} s from the clock`)
  if (typeof secret !== 'string' || !secret.startsWith('whsec_') || secret.length <= 6) throw fail('bad_secret', 'the secret must be the whsec_ value shown once when the webhook was created or rotated')
  let keyBytes: Uint8Array
  try {
    keyBytes = fromBase64(secret.slice(6))
  } catch {
    throw fail('bad_secret', 'the secret after whsec_ is not base64')
  }
  if (keyBytes.length === 0) throw fail('bad_secret', 'the secret is empty')
  const body = typeof rawBody === 'string' ? new TextEncoder().encode(rawBody) : rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody)
  const prefix = new TextEncoder().encode(`${id}.${ts}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix, 0)
  signed.set(body, prefix.length)
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  let matched = false
  for (const entry of sig.split(' ')) {
    if (!entry.startsWith('v1,')) continue
    let candidate: Uint8Array
    try {
      candidate = fromBase64(entry.slice(3))
    } catch {
      continue
    }
    if (await crypto.subtle.verify('HMAC', key, candidate as BufferSource, signed as BufferSource)) matched = true
  }
  if (!matched) throw fail('no_match', 'no webhook-signature entry matches this body and secret')
  return body
}

/** Verifies a Carbium delivery (see verifyWebhookSignature) and returns its events: the body is always a JSON array of one transaction. Adds reason bad_json. */
export async function verifyWebhook(rawBody: Uint8Array | ArrayBuffer | string, headers: WebhookHeaders, secret: string, options: VerifyWebhookOptions = {}): Promise<WebhookEvent[]> {
  const body = await verifyWebhookSignature(rawBody, headers, secret, options)
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed as WebhookEvent[]
  } catch {
    throw fail('bad_json', 'the body verified but is not a JSON array')
  }
}
