/**
 * Request and answer types for every served JSON-RPC method, as the door answers them on the wire (JSON numbers
 * stay numbers; lamports and slots above 2^53 lose precision, as in any plain JSON client). Amounts the quote plane
 * serves are decimal strings and keep full precision.
 */

export type Commitment = 'processed' | 'confirmed' | 'finalized'
export type Encoding = 'base58' | 'base64' | 'base64+zstd' | 'jsonParsed'
export type TransactionEncoding = 'json' | 'jsonParsed' | 'base58' | 'base64'
/** The two text encodings of raw bytes. */
export type BinaryEncoding = 'base58' | 'base64'
/** How raw account data is encoded in an answer. */
export type AccountDataEncoding = BinaryEncoding | 'base64+zstd'
/** A memcmp filter's encoding on programSubscribe, which also takes raw bytes; getProgramAccounts takes BinaryEncoding only. */
export type MemcmpEncoding = BinaryEncoding | 'bytes'
/** How much of each transaction getBlock returns. */
export type TransactionDetails = 'full' | 'accounts' | 'signatures' | 'none'
export type SortOrder = 'asc' | 'desc'
export type PriorityLevel = 'Min' | 'Low' | 'Medium' | 'High' | 'VeryHigh' | 'UnsafeMax'
export type Base58 = string
export type Base64 = string

export interface CommitmentConfig {
  commitment?: Commitment
  minContextSlot?: number
}
export interface DataSlice {
  offset: number
  length: number
}
export interface Context {
  slot: number
  apiVersion?: string
}
export interface WithContext<T> {
  context: Context
  value: T
}
export interface ParsedData {
  program: string
  parsed: unknown
  space: number
}
/** Raw account data as [data, encoding], parsed JSON, or the bare base58 string a node sends when no encoding was asked. */
export type EncodedData = [data: string, encoding: AccountDataEncoding] | ParsedData | string
export interface AccountInfo {
  lamports: number
  owner: Base58
  data: EncodedData
  executable: boolean
  /**
   * u64. Rent-exempt accounts carry u64::MAX, which JSON parsing turns into 18446744073709552000; that still equals
   * the literal 18446744073709551615 in JavaScript, so `rentEpoch === 18446744073709551615` works. For exact u64
   * arithmetic use @solana/kit, whose codecs read every u64 as a bigint.
   */
  rentEpoch: number
  space?: number
}
export interface KeyedAccount {
  pubkey: Base58
  account: AccountInfo
}
export interface AccountInfoConfig extends CommitmentConfig {
  encoding?: Encoding
  dataSlice?: DataSlice
}
export interface TokenAmount {
  amount: string
  decimals: number
  uiAmount: number | null
  uiAmountString: string
}
export type TransactionError = string | Record<string, unknown>
export interface TokenBalance {
  accountIndex: number
  mint: Base58
  owner?: Base58
  programId?: Base58
  uiTokenAmount: TokenAmount
}
export interface InnerInstructions {
  index: number
  instructions: unknown[]
}
export interface LoadedAddresses {
  writable: Base58[]
  readonly: Base58[]
}
export interface TransactionMeta {
  err: TransactionError | null
  fee: number
  preBalances: number[]
  postBalances: number[]
  innerInstructions?: InnerInstructions[] | null
  preTokenBalances?: TokenBalance[] | null
  postTokenBalances?: TokenBalance[] | null
  logMessages?: string[] | null
  loadedAddresses?: LoadedAddresses
  returnData?: { programId: Base58; data: [Base64, 'base64'] }
  computeUnitsConsumed?: number
  costUnits?: number
  rewards?: Reward[] | null
  status?: { Ok: null } | { Err: TransactionError }
}
export interface Reward {
  pubkey: Base58
  lamports: number
  postBalance: number
  rewardType: string | null
  commission?: number
}
/** A transaction as json or jsonParsed, or encoded as [data, encoding]. */
export type AccountKeySource = 'transaction' | 'lookupTable'
/** A getBlock account entry, transactionDetails "accounts". */
export interface TransactionAccountKey {
  pubkey: Base58
  signer: boolean
  writable: boolean
  source: AccountKeySource
}
/** A transaction as [data, encoding], as json or jsonParsed, or (getBlock with transactionDetails "accounts") its signatures and account keys. */
export type EncodedTransaction = [data: string, encoding: BinaryEncoding] | { signatures: Base58[]; message: Record<string, unknown> } | { signatures: Base58[]; accountKeys: TransactionAccountKey[] }
export interface TransactionWithMeta {
  slot: number
  transaction: EncodedTransaction
  meta: TransactionMeta | null
  blockTime?: number | null
  version?: 'legacy' | 0 | 1
}
export interface TransactionConfig extends CommitmentConfig {
  encoding?: TransactionEncoding
  maxSupportedTransactionVersion?: number
}
export interface BlockConfig extends TransactionConfig {
  transactionDetails?: TransactionDetails
  rewards?: boolean
}
export interface Block {
  blockhash: Base58
  previousBlockhash: Base58
  parentSlot: number
  blockHeight: number | null
  blockTime: number | null
  transactions?: Array<{ transaction: EncodedTransaction; meta: TransactionMeta | null; version?: 'legacy' | 0 | 1 }>
  signatures?: Base58[]
  rewards?: Reward[]
  numRewardPartitions?: number
}
export interface SignatureInfo {
  signature: Base58
  slot: number
  err: TransactionError | null
  memo: string | null
  blockTime: number | null
  confirmationStatus?: Commitment | null
}
export interface SignaturesForAddressConfig extends CommitmentConfig {
  limit?: number
  before?: Base58
  until?: Base58
}
export interface SignatureStatus {
  slot: number
  confirmations: number | null
  err: TransactionError | null
  confirmationStatus: Commitment | null
  status?: { Ok: null } | { Err: TransactionError }
}
export interface EpochInfo {
  absoluteSlot: number
  blockHeight: number
  epoch: number
  slotIndex: number
  slotsInEpoch: number
  transactionCount: number | null
}
export interface EpochSchedule {
  slotsPerEpoch: number
  leaderScheduleSlotOffset: number
  warmup: boolean
  firstNormalEpoch: number
  firstNormalSlot: number
}
export interface InflationGovernor {
  initial: number
  terminal: number
  taper: number
  foundation: number
  foundationTerm: number
}
export interface InflationRate {
  total: number
  validator: number
  foundation: number
  epoch: number
}
export interface InflationReward {
  epoch: number
  effectiveSlot: number
  amount: number
  postBalance: number
  commission?: number | null
}
export interface VoteAccount {
  votePubkey: Base58
  nodePubkey: Base58
  activatedStake: number
  epochVoteAccount: boolean
  commission: number
  lastVote: number
  epochCredits: Array<[epoch: number, credits: number, previousCredits: number]>
  rootSlot: number
}
export interface VoteAccounts {
  current: VoteAccount[]
  delinquent: VoteAccount[]
}
export interface VoteAccountsConfig {
  commitment?: Commitment
  votePubkey?: Base58
  keepUnstakedDelinquents?: boolean
  delinquentSlotDistance?: number
}
export interface ClusterNode {
  pubkey: Base58
  gossip: string | null
  tpu: string | null
  tpuQuic?: string | null
  rpc: string | null
  pubsub?: string | null
  version: string | null
  featureSet: number | null
  shredVersion: number | null
}
export interface PerformanceSample {
  slot: number
  numTransactions: number
  numNonVoteTransactions?: number
  numSlots: number
  samplePeriodSecs: number
}
export interface PrioritizationFee {
  slot: number
  prioritizationFee: number
}
export interface Supply {
  total: number
  circulating: number
  nonCirculating: number
  nonCirculatingAccounts: Base58[]
}
export interface LargestAccount {
  address: Base58
  lamports: number
}
export interface BlockProduction {
  byIdentity: Record<Base58, [leaderSlots: number, blocksProduced: number]>
  range: { firstSlot: number; lastSlot: number }
}
export interface BlockProductionConfig {
  commitment?: Commitment
  identity?: Base58
  range?: { firstSlot: number; lastSlot?: number }
}
export interface BlockCommitment {
  commitment: number[] | null
  totalStake: number
}
export type LeaderSchedule = Record<Base58, number[]> | null
export interface LeaderScheduleConfig {
  commitment?: Commitment
  identity?: Base58
}
export interface SimulateTransactionConfig {
  sigVerify?: boolean
  commitment?: Commitment
  encoding?: BinaryEncoding
  replaceRecentBlockhash?: boolean
  minContextSlot?: number
  innerInstructions?: boolean
  accounts?: { addresses: Base58[]; encoding?: Encoding }
}
export interface SimulateTransactionResult {
  err: TransactionError | null
  logs: string[] | null
  accounts?: Array<AccountInfo | null> | null
  unitsConsumed?: number
  returnData?: { programId: Base58; data: [Base64, 'base64'] } | null
  innerInstructions?: InnerInstructions[] | null
  replacementBlockhash?: { blockhash: Base58; lastValidBlockHeight: number } | null
}
export interface SendTransactionConfig {
  encoding?: BinaryEncoding
  skipPreflight?: boolean
  preflightCommitment?: Commitment
  maxRetries?: number
  minContextSlot?: number
}
export interface LatestBlockhash {
  blockhash: Base58
  lastValidBlockHeight: number
}
export interface ProgramAccountsFilter {
  memcmp?: { offset: number; bytes: string; encoding?: BinaryEncoding }
  dataSize?: number
}
export interface ProgramAccountsConfig extends AccountInfoConfig {
  filters?: ProgramAccountsFilter[]
  withContext?: boolean
}
export type TokenAccountsFilter = { mint: Base58 } | { programId: Base58 }
export interface HighestSnapshotSlot {
  full: number
  incremental: number | null
}
export interface Version {
  'solana-core': string
  'feature-set'?: number
}
export interface RecentPerformanceSamplesLimit {}

// Vendor-compatible extras
export interface PriorityFeeEstimateParams {
  accountKeys?: Base58[]
  transaction?: string
  options?: {
    priorityLevel?: PriorityLevel
    includeAllPriorityFeeLevels?: boolean
    recommended?: boolean
    lookbackSlots?: number
    transactionEncoding?: BinaryEncoding
  }
}
export interface PriorityFeeEstimate {
  priorityFeeEstimate?: number
  priorityFeeLevels?: { min: number; low: number; medium: number; high: number; veryHigh: number; unsafeMax: number }
}
export interface QnPriorityFeesParams {
  last_n_blocks?: number
  account?: Base58
  api_version?: number
}
export interface QnPriorityFeeLevels {
  extreme: number
  high: number
  medium: number
  low: number
  percentiles: Record<string, number>
}
export interface QnPriorityFees {
  context: { slot: number }
  per_compute_unit: QnPriorityFeeLevels
  per_transaction: QnPriorityFeeLevels
  recommended: number
}
export interface SlotRange {
  gte?: number
  gt?: number
  lte?: number
  lt?: number
  eq?: number
}
/** getTransactionsForAddress: signatures (default) or full transactions. */
export type AddressHistoryDetails = 'signatures' | 'full'
export type HistoryStatusFilter = 'succeeded' | 'failed' | 'any'
export type HistoryTokenAccounts = 'none' | 'balanceChanged' | 'all'
export type TransferDirection = 'in' | 'out' | 'any'
export interface TransactionsForAddressConfig extends TransactionConfig {
  limit?: number
  transactionDetails?: AddressHistoryDetails
  sortOrder?: SortOrder
  paginationToken?: string
  filters?: {
    slot?: SlotRange
    blockTime?: SlotRange
    status?: HistoryStatusFilter
    tokenAccounts?: HistoryTokenAccounts
    tokenTransfer?: { with?: Base58; mint?: Base58; direction?: TransferDirection; amount?: SlotRange }
  }
}
export interface TransactionsForAddress {
  data: Array<SignatureInfo | (TransactionWithMeta & { transactionIndex: number })>
  paginationToken: string | null
  historyFloor?: number
  droppedRows?: number
}

// DAS (Helius field names)
export interface DasDisplayOptions {
  showFungible?: boolean
  showNativeBalance?: boolean
  showZeroBalance?: boolean
  showCollectionMetadata?: boolean
  showUnverifiedCollections?: boolean
  showGrandTotal?: boolean
  showInscription?: boolean
  showRawData?: boolean
  requireFullIndex?: boolean
  showSystemMetadata?: boolean
  showClosedAccounts?: boolean
}
export type DasSortBy = 'id' | 'created' | 'updated' | 'recent_action' | 'none'
/** A DAS list's order: sortBy defaults to id, sortDirection to desc. */
export interface DasSort {
  sortBy: DasSortBy
  sortDirection?: SortOrder
}
export interface DasPaging {
  page?: number
  limit?: number
  cursor?: string
  before?: string
  after?: string
  sortBy?: DasSort
  options?: DasDisplayOptions
  displayOptions?: DasDisplayOptions
}
/** A DAS asset as the index answers it. The off-chain JSON is never fetched: content.files is [] and links is {}. */
export interface DasAsset {
  interface: string
  id: Base58
  content?: Record<string, unknown>
  authorities?: Array<{ address: Base58; scopes: string[] }>
  compression?: Record<string, unknown>
  grouping?: Array<{ group_key: string; group_value: string; verified?: boolean }>
  royalty?: Record<string, unknown>
  creators?: Array<{ address: Base58; share: number; verified: boolean }>
  ownership: { frozen: boolean; delegated: boolean; delegate: Base58 | null; ownership_model: string; owner: Base58 }
  supply?: Record<string, unknown> | null
  mutable: boolean
  burnt: boolean
  token_info?: Record<string, unknown>
  mint_extensions?: Record<string, unknown>
  plugins?: Record<string, unknown>
  external_plugins?: unknown[]
  mpl_core_info?: Record<string, unknown>
  inscription?: Record<string, unknown>
  [extra: string]: unknown
}
export interface DasAssetList {
  total: number
  limit: number
  page?: number
  cursor?: string
  before?: string
  after?: string
  items: DasAsset[]
  grand_total?: number
  nativeBalance?: { lamports: number }
  last_indexed_slot?: number
}
export interface DasTokenAccount {
  address: Base58
  mint: Base58
  owner: Base58
  amount: number
  delegated_amount: number
  frozen: boolean
  [extra: string]: unknown
}
export interface DasTokenAccountList {
  total: number
  limit: number
  page?: number
  cursor?: string
  token_accounts: DasTokenAccount[]
  last_indexed_slot?: number
}
export interface DasEdition {
  mint: Base58
  edition_address: Base58
  edition: number
}
export interface DasEditionList {
  total: number
  limit: number
  page: number
  master_edition_address: Base58
  supply: number
  max_supply: number | null
  editions: DasEdition[]
}
export type DasGrouping = [key: string, value: string] | { collection: string } | { group_key: string; group_value: string }
export type DasTokenType = 'fungible' | 'nonFungible' | 'regularNft' | 'compressedNft' | 'all'
export interface SearchAssetsParams extends DasPaging {
  ownerAddress?: Base58
  creatorAddress?: Base58
  creatorVerified?: boolean
  authorityAddress?: Base58
  grouping?: DasGrouping
  interface?: string
  tokenType?: DasTokenType
  frozen?: boolean
  delegate?: Base58
  burnt?: boolean
  compressed?: boolean
  negate?: false
  conditionType?: 'all'
}

// Quote plane
export interface QuoteParams {
  src_mint: Base58
  dst_mint: Base58
  /** Base units; a decimal string above 2^53. */
  amount_in: number | string
  slippage_bps: number
  /** One venue family label or 1 to 17 of them; `dexes` is its alias. */
  dex?: string | string[]
  dexes?: string | string[]
  txVersion?: 0 | 1
  swapTag?: 0 | 1
}
export interface RouteLeg {
  hop: number
  percent: string
  swapInfo: { ammKey: Base58; label: string; inputMint: Base58; outputMint: Base58; inAmount: string; outAmount: string }
}
export interface Quote {
  srcAmountIn: string
  destAmountOut: string
  minAmountOut: string
  slippageBps: number
  swapMode: 'BaseIn'
  inputMint: Base58
  outputMint: Base58
  routePlan: RouteLeg[]
  quoteId: string
  platformFee?: { amount: string; feeBps: number; mint: Base58 }
  txVersion?: 1
  swapTag?: 1
  partial?: true
  requestedAmountIn?: string
  [extra: string]: unknown
}
export interface SwapParams {
  quote_id: string
  /** The wallet that signs and pays: the only signer of the unsigned transaction returned. */
  user_pubkey: Base58
  compute_unit_price_micro_lamports?: number | null
}
/** One unsigned transaction for the user's own wallet to sign and send. */
export interface Swap {
  transaction: Base64
  blockhash: Base58
  lastValidBlockHeight: number
  minAmountOut: string
  computeUnitLimit: number
  priorityFeeLamports: string
  rentLamports: string | null
  ataCreates: number
  txVersion?: 1
  swapTag?: 1
  /** deadPool is left out when the reroute came from an oversized transaction rather than a dead pool. */
  routeRerouted?: { why: string; deadPool?: Base58; quotedOut: string; reroutedOut: string; floor: string }
  [extra: string]: unknown
}
/** GET /cq1/quote: all four are required and no other parameter is offered. */
export interface Cq1QuoteParams {
  src_mint: Base58
  dst_mint: Base58
  /** Base units of src_mint. */
  amount_in: string | number | bigint
  slippage_bps: number
}
/** The REST quote's answer: one JSON object, every value a string. Fields not listed here may appear and are kept. */
export interface Cq1Quote {
  srcAmountIn: string
  destAmountOut: string
  destAmountOutMin: string
  swapMode: string
  slippage: string
  priceImpactPct: string
  routePlan: Array<{ swapInfo: { ammKey: Base58; label: string; inputMint: Base58; outputMint: Base58; inAmount: string; outAmount: string; feeAmount: string; feeMint: Base58 }; percent: string; bps: string }>
  feeMint: Base58
  feeBps: string
  signatureFeeLamports: string
  prioritizationFeeLamports: string
  rentFeeLamports: string
  inputMint: Base58
  outputMint: Base58
  swapType: string
  router: string
  requestId: string
  priceImpact: string
  [extra: string]: unknown
}
export interface PricesParams {
  mints?: Base58[]
}
export interface Prices {
  solUsd: number
  builtUnix: number
  priced: number
  /** How many rows are stale (0 when none). */
  stale: number
  noroute: number
  total: number
  rows: Array<[mint: Base58, priceUsd: number | null, tvlUsd: number, quoteMint: Base58]>
}
export interface QuoteHealth {
  ok: boolean
  quoteUpstream: unknown
  canBuild: boolean
  families: string[]
  poolStore: unknown
  chainRpc: unknown
  priced: number
  total: number
  /** How many priced rows are stale (0 when none). */
  stale: number
  tableAgeSecs: number
  quote_refusal_ratio: number
  [extra: string]: unknown
}

/** Every served method: its params (a positional tuple, one object, or void) and its result. */
export interface RpcMethods {
  getAccountInfo: { params: [pubkey: Base58, config?: AccountInfoConfig]; result: WithContext<AccountInfo | null> }
  getAgGenesisCert: { params: []; result: unknown }
  getBalance: { params: [pubkey: Base58, config?: CommitmentConfig]; result: WithContext<number> }
  getBlock: { params: [slot: number, config?: BlockConfig]; result: Block | null }
  getBlockCommitment: { params: [slot: number]; result: BlockCommitment }
  getBlockHeight: { params: [config?: CommitmentConfig]; result: number }
  getBlockProduction: { params: [config?: BlockProductionConfig]; result: WithContext<BlockProduction> }
  getBlocks: { params: [startSlot: number, endSlot?: number, config?: { commitment?: Commitment }]; result: number[] }
  getBlocksWithLimit: { params: [startSlot: number, limit: number, config?: { commitment?: Commitment }]; result: number[] }
  getBlockTime: { params: [slot: number]; result: number | null }
  getClusterNodes: { params: []; result: ClusterNode[] }
  getEpochInfo: { params: [config?: CommitmentConfig]; result: EpochInfo }
  getEpochSchedule: { params: []; result: EpochSchedule }
  getFeeForMessage: { params: [message: Base64, config?: CommitmentConfig]; result: WithContext<number | null> }
  getFirstAvailableBlock: { params: []; result: number }
  getGenesisHash: { params: []; result: Base58 }
  getHealth: { params: []; result: 'ok' }
  getHighestSnapshotSlot: { params: []; result: HighestSnapshotSlot }
  getIdentity: { params: []; result: { identity: Base58 } }
  getInflationGovernor: { params: [config?: { commitment?: Commitment }]; result: InflationGovernor }
  getInflationRate: { params: []; result: InflationRate }
  getInflationReward: { params: [addresses: Base58[], config?: { commitment?: Commitment; epoch?: number; minContextSlot?: number }]; result: Array<InflationReward | null> }
  getLargestAccounts: { params: [config?: CommitmentConfig]; result: WithContext<LargestAccount[]> }
  getLatestBlockhash: { params: [config?: CommitmentConfig]; result: WithContext<LatestBlockhash> }
  getLeaderSchedule: { params: [slot?: number | null, config?: LeaderScheduleConfig]; result: LeaderSchedule }
  getMaxRetransmitSlot: { params: []; result: number }
  getMaxShredInsertSlot: { params: []; result: number }
  getMinimumBalanceForRentExemption: { params: [dataLength: number, config?: { commitment?: Commitment }]; result: number }
  getMultipleAccounts: { params: [pubkeys: Base58[], config?: AccountInfoConfig]; result: WithContext<Array<AccountInfo | null>> }
  getPriorityFeeEstimate: { params: PriorityFeeEstimateParams; result: PriorityFeeEstimate }
  getProgramAccounts: { params: [programId: Base58, config?: ProgramAccountsConfig]; result: KeyedAccount[] | WithContext<KeyedAccount[]> }
  getRecentPerformanceSamples: { params: [limit?: number]; result: PerformanceSample[] }
  getRecentPrioritizationFees: { params: [addresses?: Base58[]]; result: PrioritizationFee[] }
  getSignaturesForAddress: { params: [address: Base58, config?: SignaturesForAddressConfig]; result: SignatureInfo[] }
  getSignatureStatuses: { params: [signatures: Base58[], config?: { searchTransactionHistory?: boolean }]; result: WithContext<Array<SignatureStatus | null>> }
  getSlot: { params: [config?: CommitmentConfig]; result: number }
  getSlotLeader: { params: [config?: CommitmentConfig]; result: Base58 }
  getSlotLeaders: { params: [startSlot: number, limit: number]; result: Base58[] }
  getStakeMinimumDelegation: { params: [config?: { commitment?: Commitment }]; result: WithContext<number> }
  getSupply: { params: [config?: CommitmentConfig & { excludeNonCirculatingAccountsList?: boolean }]; result: WithContext<Supply> }
  getTokenAccountBalance: { params: [tokenAccount: Base58, config?: { commitment?: Commitment }]; result: WithContext<TokenAmount> }
  getTokenAccountsByDelegate: { params: [delegate: Base58, filter: TokenAccountsFilter, config?: AccountInfoConfig]; result: WithContext<KeyedAccount[]> }
  getTokenAccountsByOwner: { params: [owner: Base58, filter: TokenAccountsFilter, config?: AccountInfoConfig]; result: WithContext<KeyedAccount[]> }
  getTokenSupply: { params: [mint: Base58, config?: { commitment?: Commitment }]; result: WithContext<TokenAmount> }
  getTransaction: { params: [signature: Base58, config?: TransactionConfig]; result: TransactionWithMeta | null }
  getTransactionCount: { params: [config?: CommitmentConfig]; result: number }
  getTransactionsForAddress: { params: [address: Base58, config?: TransactionsForAddressConfig]; result: TransactionsForAddress }
  getVersion: { params: []; result: Version }
  getVoteAccounts: { params: [config?: VoteAccountsConfig]; result: VoteAccounts }
  isBlockhashValid: { params: [blockhash: Base58, config?: CommitmentConfig]; result: WithContext<boolean> }
  minimumLedgerSlot: { params: []; result: number }
  qn_estimatePriorityFees: { params: QnPriorityFeesParams; result: QnPriorityFees }
  /** Sends bytes the user's own wallet signed. Never retried: check getSignatureStatuses and resend the same bytes yourself. */
  sendTransaction: { params: [signedTransaction: string, config?: SendTransactionConfig]; result: Base58 }
  simulateTransaction: { params: [transaction: string, config?: SimulateTransactionConfig]; result: WithContext<SimulateTransactionResult> }
  // DAS
  getAsset: { params: { id: Base58; options?: DasDisplayOptions; displayOptions?: DasDisplayOptions }; result: DasAsset }
  getAssetBatch: { params: { ids: Base58[]; options?: DasDisplayOptions; displayOptions?: DasDisplayOptions }; result: Array<DasAsset | null> }
  getAssets: { params: { ids: Base58[]; options?: DasDisplayOptions; displayOptions?: DasDisplayOptions }; result: Array<DasAsset | null> }
  getAssetsByAuthority: { params: DasPaging & { authorityAddress: Base58 }; result: DasAssetList }
  getAssetsByCreator: { params: DasPaging & { creatorAddress: Base58; onlyVerified?: boolean }; result: DasAssetList }
  getAssetsByGroup: { params: DasPaging & { groupKey: string; groupValue: string }; result: DasAssetList }
  getAssetsByOwner: { params: DasPaging & { ownerAddress: Base58 }; result: DasAssetList }
  getNftEditions: { params: { mint: Base58; page?: number; limit?: number }; result: DasEditionList }
  getTokenAccounts: { params: { owner?: Base58; mint?: Base58; page?: number; limit?: number; cursor?: string; options?: { showZeroBalance?: boolean } }; result: DasTokenAccountList }
  searchAssets: { params: SearchAssetsParams; result: DasAssetList }
  // Quote plane (needs the account's quote module and a key with the quote scope)
  quote: { params: QuoteParams; result: Quote }
  swap: { params: SwapParams; result: Swap }
  prices: { params: PricesParams | void; result: Prices }
  health: { params: void; result: QuoteHealth }
}
