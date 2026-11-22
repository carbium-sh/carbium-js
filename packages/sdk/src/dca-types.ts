/** A u64 on the way in: a decimal string, a safe integer or a bigint. Sent as a decimal string. */
export type U64Input = string | number | bigint

export type DcaFrequency = 'hourly' | 'daily' | 'weekly' | 'biweekly' | 'monthly'

interface DcaOpenBase {
  /** The wallet that signs and pays. */
  owner: string
  inputMint: string
  outputMint: string
  /** 1 or more buys. */
  cycles: number
  /** Default 50, cap 300. */
  maxSlippageBps?: number
  /** 0 or a Unix time up to 30 days ahead. */
  startAt?: number
  /** 0 to 255, for several positions on one pair. */
  index?: number
  /** A floor on the output per 1e6 of input; exclusive with maxPrice. */
  minOutE6?: U64Input
  /** A maximum price, as a decimal string: the most whole input tokens per whole output token ("150.5"); exclusive with minOutE6. */
  maxPrice?: string
}
export type DcaOpenRequest = DcaOpenBase & ({ amountPerCycle: U64Input } | { totalAmount: U64Input }) & ({ intervalSecs: number } | { frequency: DcaFrequency })

export interface DcaUpdateRequest {
  owner: string
  position: string
  paused?: boolean
  minOutE6?: U64Input
  /** A decimal string as at open; null clears the maximum price. */
  maxPrice?: string | null
  maxSlippageBps?: number
}
export interface DcaWithdrawRequest {
  owner: string
  position: string
  /** 0 or left out withdraws the whole escrow. */
  amount?: U64Input
}
export interface DcaCloseRequest {
  owner: string
  position: string
}
export interface DcaSendRequest {
  /** The transaction this API built, signed by the owner's own wallet, base64. */
  txn_base64: string
  /** The build answer's txn_base64, when the wallet changed the message (priority fee, Lighthouse). */
  built_txn_base64?: string
}
export interface DcaQuoteRequest {
  inputMint: string
  outputMint: string
  amount: U64Input
  slippageBps?: number
  owner?: string
}

/** A built, unsigned v0 transaction (no lookup tables) for the owner to sign and send. */
export interface DcaBuild<Summary = Record<string, unknown>> {
  ok: true
  txn_base64: string
  blockhash: string
  /** A u64, so a decimal string. */
  last_valid_block_height: string
  position: string
  cost: Record<string, unknown>
  summary: Summary & { kind: string; owner: string; feePayer: string; instructions: string[] }
  [extra: string]: unknown
}
export interface DcaOpenBuild extends DcaBuild {
  authority: string
  escrowAccount: string
  index: number
  plan: Record<string, unknown>
}
export interface DcaSent {
  ok: true
  kind: string
  signature: string
  sent: boolean
  position: string
  [extra: string]: unknown
}
export interface DcaQuote {
  ok: true
  /** The amount asked, echoed. */
  amount: string
  out: string
  minOut: string
  rateE6: string
  feeBps: number
  inDecimals: number
  outDecimals: number
  /** The amount's value in USDC base units (6 decimals). */
  valueUsdc: string
  /** minAmountPerCycle is null when the amount has no USDC value. */
  limits: { minAmountPerCycle: string | null; minValueUsdc: string; minIntervalSecs: number; maxCycles: number; maxActive: number; [extra: string]: unknown }
  cost?: { requiredLamports: string; heldLamports: string }
  [extra: string]: unknown
}
export type DcaStatus = 'active' | 'waiting' | 'paused' | 'not_served' | 'empty' | 'finished' | 'closed' | (string & {})
export interface DcaBuy {
  signature: string
  cycle: number
  inAmount: string
  outAmount: string
  /** Unix seconds, as a decimal string. */
  ts: string
  slot: number | null
  openedSlot: number
  verdict: 'filled' | 'missed'
  detail: string | null
}
export interface DcaPosition {
  address: string
  owner: string
  inMint: string
  outMint: string
  crank: string
  inProgram: string
  outProgram: string
  index: number
  maxSlippageBps: number
  cyclesTotal: number
  cyclesDone: number
  intervalSecs: number
  amountPerCycle: string
  minOutE6: string
  cumIn: string
  cumOut: string
  nextTs: string
  active: boolean
  escrow: string | null
  middleDebt: unknown
  status: DcaStatus
  statusCode: string
  statusDetail: string | null
  lastTry: { at: number; cycle: number; result: string; code: string; detail: string | null; signature: string | null } | null
  /** Null until the keeper first sees the opening. */
  openedSlot: number | null
  /** Null until the keeper finds the opening on the chain, and for good when three looks found none. */
  openedSignature: string | null
  served: boolean | null
  notServed: string | null
  [extra: string]: unknown
}
export interface DcaPositionDetail extends DcaPosition {
  /** The owner's input and output token balances; null when the account does not exist. */
  ownerIn: string | null
  ownerOut: string | null
  tracked: boolean
  fills: DcaBuy[]
}
export interface DcaClosedRecord {
  address: string
  closed: true
  closedSlot: number
  openedSlot: number
  /** Null until the keeper finds the opening on the chain, and for good when it finds none. */
  openedSignature: string | null
  status: 'closed'
  statusCode: 'closed'
  statusDetail: null
  lastTry: unknown
  fills: DcaBuy[]
  [extra: string]: unknown
}
export interface DcaPositions {
  ok: true
  owner: string
  positions: DcaPosition[]
  next: string | null
}
/** An ended DCA as /history lists it: its own field set, not a full position. Times are Unix seconds as decimal strings. */
export interface DcaHistoryOrder {
  address: string
  inMint: string
  outMint: string
  cyclesDone: number
  cyclesTotal: number
  amountPerCycle: string
  intervalSecs: number
  cumIn: string
  cumOut: string
  minOutE6: string
  openedSlot: number
  openedSignature: string | null
  openedTs: string | null
  closedSlot: number
  closedSignature: string | null
  closedTs: string | null
  lastTry: unknown
  ended: 'finished' | 'emptied' | 'closed_early'
  [extra: string]: unknown
}
export interface DcaHistory {
  ok: true
  owner: string
  orders: DcaHistoryOrder[]
  next: string | null
}
export type DcaHealth = { ok: boolean; keeper: string; [extra: string]: unknown }
