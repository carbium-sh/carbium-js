import type { CommitmentLevel, SubscribeRequest, SubscribeRequestAccountsDataSlice, SubscribeRequestFilterAccounts, SubscribeRequestFilterBlocks, SubscribeRequestFilterBlocksMeta, SubscribeRequestFilterEntry, SubscribeRequestFilterSlots, SubscribeRequestFilterTransactions } from '@triton-one/yellowstone-grpc'
import { CarbiumError } from './errors.ts'

export const DEFAULT_STREAM_ENDPOINT = 'https://services.carbium.sh:9443'

/** The seven served filter kinds plus the request-level fields. blockFooter, token_accounts and cuckoo filters are refused by the service. */
export interface StreamFilters {
  accounts?: Record<string, SubscribeRequestFilterAccounts>
  slots?: Record<string, SubscribeRequestFilterSlots>
  transactions?: Record<string, SubscribeRequestFilterTransactions>
  transactionsStatus?: Record<string, SubscribeRequestFilterTransactions>
  blocks?: Record<string, SubscribeRequestFilterBlocks>
  blocksMeta?: Record<string, SubscribeRequestFilterBlocksMeta>
  entry?: Record<string, SubscribeRequestFilterEntry>
  /** Unset means processed. */
  commitment?: CommitmentLevel
  accountsDataSlice?: SubscribeRequestAccountsDataSlice[]
  /** Replay from this slot; processed commitment only, and only in the first request. */
  fromSlot?: string | number | bigint
}

const PROCESSED = 0

function refused(what: string): CarbiumError {
  return new CarbiumError({ kind: 'request', message: `${what} is refused by Carbon Stream: remove the field` })
}

/** A complete SubscribeRequest with every map present, refusing locally what the service refuses. */
export function buildRequest(filters: StreamFilters): SubscribeRequest {
  for (const [name, f] of Object.entries(filters.accounts ?? {})) if ((f as { cuckooAccountsFilter?: unknown }).cuckooAccountsFilter) throw refused(`accounts.${name}.cuckooAccountsFilter`)
  for (const kind of ['transactions', 'transactionsStatus'] as const) {
    for (const [name, f] of Object.entries(filters[kind] ?? {})) {
      const t = f as { tokenAccounts?: unknown; cuckooAccountInclude?: unknown }
      if (t.tokenAccounts) throw refused(`${kind}.${name}.tokenAccounts`)
      if (t.cuckooAccountInclude) throw refused(`${kind}.${name}.cuckooAccountInclude`)
      if (Object.values(f).every((v) => v === undefined || (Array.isArray(v) && v.length === 0))) {
        throw new CarbiumError({ kind: 'request', message: `${kind}.${name} is a bare transaction filter: name accountInclude, accountRequired, accountExclude, signature, vote or failed` })
      }
    }
  }
  for (const [name, f] of Object.entries(filters.blocks ?? {})) if ((f as { cuckooAccountInclude?: unknown }).cuckooAccountInclude) throw refused(`blocks.${name}.cuckooAccountInclude`)
  for (const [name, f] of Object.entries(filters.entry ?? {})) if ((f as { includeUpdateParent?: unknown }).includeUpdateParent) throw refused(`entry.${name}.includeUpdateParent`)
  if (filters.fromSlot !== undefined && filters.commitment !== undefined && filters.commitment !== PROCESSED) {
    throw new CarbiumError({ kind: 'request', message: 'fromSlot replay is available only at processed commitment' })
  }
  const request: SubscribeRequest = {
    accounts: { ...filters.accounts },
    slots: { ...filters.slots },
    transactions: { ...filters.transactions },
    transactionsStatus: { ...filters.transactionsStatus },
    blocks: { ...filters.blocks },
    blocksMeta: { ...filters.blocksMeta },
    entry: { ...filters.entry },
    accountsDataSlice: [...(filters.accountsDataSlice ?? [])],
    blockFooter: {},
  }
  if (filters.commitment !== undefined) request.commitment = filters.commitment
  if (filters.fromSlot !== undefined) request.fromSlot = String(filters.fromSlot)
  return request
}

export type GrpcStatus = 'OK' | 'CANCELLED' | 'UNKNOWN' | 'INVALID_ARGUMENT' | 'DEADLINE_EXCEEDED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'PERMISSION_DENIED' | 'RESOURCE_EXHAUSTED' | 'FAILED_PRECONDITION' | 'ABORTED' | 'OUT_OF_RANGE' | 'UNIMPLEMENTED' | 'INTERNAL' | 'UNAVAILABLE' | 'DATA_LOSS' | 'UNAUTHENTICATED'
const STATUS_BY_CODE: readonly GrpcStatus[] = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED']
const STATUS_BY_TEXT: ReadonlyArray<[RegExp, GrpcStatus]> = [
  [/valid authentication credentials/i, 'UNAUTHENTICATED'],
  [/does not have permission/i, 'PERMISSION_DENIED'],
  [/resource has been exhausted/i, 'RESOURCE_EXHAUSTED'],
  [/currently unavailable/i, 'UNAVAILABLE'],
  [/past the valid range/i, 'OUT_OF_RANGE'],
  [/invalid argument/i, 'INVALID_ARGUMENT'],
  [/deadline expired/i, 'DEADLINE_EXCEEDED'],
  [/not implemented/i, 'UNIMPLEMENTED'],
  [/was cancelled/i, 'CANCELLED'],
  [/internal error/i, 'INTERNAL'],
]

export type StreamAction = 'stop' | 'reseed' | 'retry'
export interface StreamErrorInfo {
  status: GrpcStatus
  /** The gRPC status name, or TLS_ROOTS when this machine has no CA certificates for the stream client. */
  reason: string
  message: string
  action: StreamAction
  /** From the published table: the N-API client hides retry-after metadata. */
  retryAfterMs: number
}

/** Reads a gRPC status from a grpc-js error (numeric code) or the N-API client's text, and decides stop, reseed or retry. */
export function classifyStreamError(error: unknown): StreamErrorInfo {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; details?: unknown; cause?: { message?: unknown } }
  const texts = [e.message, e.details, e.cause?.message].filter((t): t is string => typeof t === 'string')
  const text = texts.join(' | ')
  let status: GrpcStatus = 'UNKNOWN'
  if (typeof e.code === 'number' && STATUS_BY_CODE[e.code]) status = STATUS_BY_CODE[e.code] as GrpcStatus
  else {
    const named = /\b(UNAUTHENTICATED|PERMISSION_DENIED|RESOURCE_EXHAUSTED|UNAVAILABLE|OUT_OF_RANGE|INVALID_ARGUMENT|DEADLINE_EXCEEDED|UNIMPLEMENTED|CANCELLED|INTERNAL)\b/.exec(text)
    if (named) status = named[1] as GrpcStatus
    else for (const [re, s] of STATUS_BY_TEXT) if (re.test(text)) { status = s; break }
  }
  // the stream client is a native module that reads the system CA certificates, not the ones Node bundles: without
  // them it cannot set up TLS, and no retry can connect
  if (/invalid TLS configuration|no native certs found/i.test(text)) return { status, reason: 'TLS_ROOTS', message: 'the stream client needs the system CA certificates: install the ca-certificates package, or set SSL_CERT_FILE to a CA bundle', action: 'stop', retryAfterMs: 0 }
  const message = /message: "([^"]*)"/.exec(text)?.[1] ?? texts[0] ?? 'stream ended'
  let action: StreamAction = 'retry'
  let retryAfterMs = 2000
  switch (status) {
    case 'UNAUTHENTICATED':
    case 'PERMISSION_DENIED':
    case 'INVALID_ARGUMENT':
    case 'UNIMPLEMENTED':
      action = 'stop'
      break
    case 'OUT_OF_RANGE':
      action = 'reseed'
      break
    case 'RESOURCE_EXHAUSTED':
      if (/credits.exhausted/i.test(message)) action = 'stop'
      break
    case 'UNAVAILABLE':
      if (/still loading/i.test(message)) retryAfterMs = 1000
      break
    default:
      break
  }
  return { status, reason: status, message, action, retryAfterMs }
}
