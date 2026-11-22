/**
 * A token as tokens.carbium.io serves it. Timestamps are Unix milliseconds; supply is a decimal string. A mint the
 * registry has seen but not resolved yet has symbol and name '' and decimals 0 until it is enriched.
 */
export interface Token {
  mint: string
  symbol: string
  name: string
  decimals: number
  logo_url: string | null
  logo_status: 'ok' | 'broken' | 'broken_perm' | 'missing' | 'unchecked'
  is_token22: boolean
  daily_volume_usd: number | null
  first_seen_at: number
  last_seen_at: number
  supply: string | null
  mint_authority: string | null
  freeze_authority: string | null
  metaplex_uri: string | null
  update_authority: string | null
  seller_fee_basis_points: number | null
  /** Metaplex's TokenStandard number (0 NonFungible, 1 FungibleAsset, 2 Fungible, ...). */
  token_standard: number | null
  description: string | null
  external_url: string | null
  extensions: Record<string, unknown> | null
  /** As the token's off-chain metadata holds them: strings, or objects. */
  tags: unknown[] | null
  [extra: string]: unknown
}
export interface TokenSearch {
  items: Token[]
  page: number
  limit: number
  total: number | null
}
export interface TokenSearchOptions {
  /** 1 to 200, default 50. */
  limit?: number
  /** From 1. */
  page?: number
  includeToken22?: boolean
}
export interface TokenBatch {
  items: Token[]
  /** Mints the registry does not hold yet; they are queued for enrichment by the call itself. */
  unknown: string[]
}
