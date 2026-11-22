// Generated list of the methods the services serve; do not edit. A method the services do not serve is not offered.
// plane: which door answers; params: positional array or one object; batch: whether the method may share a JSON-RPC
// batch (any), only with other DAS methods (das), or never; permit: holds a node slot (at most two permit methods
// per batch).
export type Plane = 'rpc' | 'das' | 'quote'
export interface MethodSpec {
  readonly plane: Plane
  readonly params: 'positional' | 'object'
  readonly batch: 'any' | 'das' | 'never'
  readonly permit: boolean
}
export interface MethodTable {
  readonly getAccountInfo: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getAgGenesisCert: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getAsset: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssetBatch: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssets: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssetsByAuthority: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssetsByCreator: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssetsByGroup: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getAssetsByOwner: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getBalance: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getBlock: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getBlockCommitment: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getBlockHeight: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getBlockProduction: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getBlocks: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getBlocksWithLimit: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getBlockTime: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getClusterNodes: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getEpochInfo: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getEpochSchedule: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getFeeForMessage: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getFirstAvailableBlock: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getGenesisHash: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getHealth: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getHighestSnapshotSlot: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getIdentity: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getInflationGovernor: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getInflationRate: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getInflationReward: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getLargestAccounts: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: false }
  readonly getLatestBlockhash: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getLeaderSchedule: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getMaxRetransmitSlot: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getMaxShredInsertSlot: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getMinimumBalanceForRentExemption: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getMultipleAccounts: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getNftEditions: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getPriorityFeeEstimate: { readonly plane: 'rpc'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
  readonly getProgramAccounts: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: false }
  readonly getRecentPerformanceSamples: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getRecentPrioritizationFees: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getSignaturesForAddress: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getSignatureStatuses: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getSlot: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getSlotLeader: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getSlotLeaders: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getStakeMinimumDelegation: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getSupply: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: false }
  readonly getTokenAccountBalance: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getTokenAccounts: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly getTokenAccountsByDelegate: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: false }
  readonly getTokenAccountsByOwner: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: false }
  readonly getTokenSupply: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getTransaction: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: true }
  readonly getTransactionCount: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getTransactionsForAddress: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'never'; readonly permit: true }
  readonly getVersion: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly getVoteAccounts: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly health: { readonly plane: 'quote'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
  readonly isBlockhashValid: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly minimumLedgerSlot: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly prices: { readonly plane: 'quote'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
  readonly qn_estimatePriorityFees: { readonly plane: 'rpc'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
  readonly quote: { readonly plane: 'quote'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
  readonly searchAssets: { readonly plane: 'das'; readonly params: 'object'; readonly batch: 'das'; readonly permit: false }
  readonly sendTransaction: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly simulateTransaction: { readonly plane: 'rpc'; readonly params: 'positional'; readonly batch: 'any'; readonly permit: false }
  readonly swap: { readonly plane: 'quote'; readonly params: 'object'; readonly batch: 'never'; readonly permit: false }
}
export const METHODS: MethodTable = {
  getAccountInfo: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getAgGenesisCert: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getAsset: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssetBatch: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssets: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssetsByAuthority: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssetsByCreator: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssetsByGroup: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getAssetsByOwner: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getBalance: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getBlock: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getBlockCommitment: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getBlockHeight: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getBlockProduction: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getBlocks: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getBlocksWithLimit: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getBlockTime: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getClusterNodes: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getEpochInfo: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getEpochSchedule: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getFeeForMessage: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getFirstAvailableBlock: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getGenesisHash: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getHealth: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getHighestSnapshotSlot: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getIdentity: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getInflationGovernor: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getInflationRate: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getInflationReward: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getLargestAccounts: { plane: 'rpc', params: 'positional', batch: 'never', permit: false },
  getLatestBlockhash: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getLeaderSchedule: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getMaxRetransmitSlot: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getMaxShredInsertSlot: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getMinimumBalanceForRentExemption: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getMultipleAccounts: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getNftEditions: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getPriorityFeeEstimate: { plane: 'rpc', params: 'object', batch: 'never', permit: false },
  getProgramAccounts: { plane: 'rpc', params: 'positional', batch: 'never', permit: false },
  getRecentPerformanceSamples: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getRecentPrioritizationFees: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getSignaturesForAddress: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getSignatureStatuses: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getSlot: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getSlotLeader: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getSlotLeaders: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getStakeMinimumDelegation: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getSupply: { plane: 'rpc', params: 'positional', batch: 'never', permit: false },
  getTokenAccountBalance: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getTokenAccounts: { plane: 'das', params: 'object', batch: 'das', permit: false },
  getTokenAccountsByDelegate: { plane: 'rpc', params: 'positional', batch: 'never', permit: false },
  getTokenAccountsByOwner: { plane: 'rpc', params: 'positional', batch: 'never', permit: false },
  getTokenSupply: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getTransaction: { plane: 'rpc', params: 'positional', batch: 'any', permit: true },
  getTransactionCount: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getTransactionsForAddress: { plane: 'rpc', params: 'positional', batch: 'never', permit: true },
  getVersion: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  getVoteAccounts: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  health: { plane: 'quote', params: 'object', batch: 'never', permit: false },
  isBlockhashValid: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  minimumLedgerSlot: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  prices: { plane: 'quote', params: 'object', batch: 'never', permit: false },
  qn_estimatePriorityFees: { plane: 'rpc', params: 'object', batch: 'never', permit: false },
  quote: { plane: 'quote', params: 'object', batch: 'never', permit: false },
  searchAssets: { plane: 'das', params: 'object', batch: 'das', permit: false },
  sendTransaction: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  simulateTransaction: { plane: 'rpc', params: 'positional', batch: 'any', permit: false },
  swap: { plane: 'quote', params: 'object', batch: 'never', permit: false },
}
export type MethodName = keyof MethodTable
export type SubscriptionName = 'accountSubscribe' | 'blockSubscribe' | 'logsSubscribe' | 'programSubscribe' | 'rootSubscribe' | 'signatureSubscribe' | 'slotSubscribe' | 'slotsUpdatesSubscribe'
export const SUBSCRIPTIONS: readonly SubscriptionName[] = ["accountSubscribe","blockSubscribe","logsSubscribe","programSubscribe","rootSubscribe","signatureSubscribe","slotSubscribe","slotsUpdatesSubscribe"]
