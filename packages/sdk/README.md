# @carbium/sdk

Typed TypeScript client for Carbium's Solana services on [services.carbium.sh](https://carbium.sh): JSON-RPC (every
served method, DAS included), WebSocket subscriptions, Carbon Stream (Yellowstone gRPC), quote and swap, the account
API, webhook signature checks, the DCA API on the dex and the token API. No runtime dependencies. ESM and CJS. Node 22+
and browsers (Carbon Stream is Node only).

The SDK never holds a private key, signs or sends on its own: swap and DCA calls return one unsigned transaction for
your own wallet to sign, and `sendTransaction` takes bytes you signed. Every method the SDK offers is served; what the
services do not serve is not here.

```sh
npm install @carbium/sdk
```

Deno: `deno add jsr:@carbium/sdk`.

## Quick start

A service key (`c_serv_…`) comes from the dashboard at carbium.sh. Without one the call reaches the door and is refused
with 401, which the quick start prints.

```js
import { createCarbium, isCarbiumError } from '@carbium/sdk'

const carbium = createCarbium({ apiKey: process.env.CARBIUM_KEY })
try {
  const { context, value } = await carbium.rpc.getLatestBlockhash()
  console.log('blockhash', value.blockhash, 'valid until block height', value.lastValidBlockHeight, 'at slot', context.slot)
} catch (error) {
  if (!isCarbiumError(error)) throw error
  console.log(error.kind, error.httpStatus, error.code, error.reason, error.message)
}
```

## RPC, DAS and the quote plane

```ts
const carbium = createCarbium({ apiKey })

// Standard Solana methods and the fee extras take positional params, as on the wire.
const balance = await carbium.rpc.getBalance('So11111111111111111111111111111111111111112')
const { value: accounts } = await carbium.rpc.getMultipleAccounts([a, b], { encoding: 'base64' })
const fees = await carbium.rpc.getPriorityFeeEstimate({ accountKeys: [a], options: { recommended: true } })

// DAS methods take one object in Helius field names.
const asset = await carbium.das.getAsset({ id: mint })
const page = await carbium.das.getAssetsByOwner({ ownerAddress: owner, limit: 1000 })

// Any served method by name, typed.
const slot = await carbium.call('getSlot', [{ commitment: 'confirmed' }])

// A JSON-RPC batch (1 to 100 calls, at most two permit methods, DAS only with DAS; scans, getSupply, getLargestAccounts,
// the fee extras, getTransactionsForAddress and the quote plane never batch).
const [s, h] = await carbium.batch([{ method: 'getSlot' }, { method: 'getHealth' }])
```

Answers are plain JSON: integers above 2^53 lose their last digits, as in any JSON client. That touches lamport
totals such as `getSupply` and the rent-exempt `rentEpoch` marker (u64::MAX, still equal to `18446744073709551615` in
JavaScript); token amounts and quote-plane amounts are decimal strings and stay exact.

Token scans (`getTokenAccountsByOwner`, `getTokenAccountsByDelegate`) are billed by rows, up to 100,005 credits;
`getProgramAccounts` costs 505; a `getTransactionsForAddress` walk costs 55 plus 50 per upstream call, up to 51,255 at
`limit` 1000. Name a mint, keep `limit` small, and read the method notes at https://carbium.sh/skill.md before running
one in a loop.

The quote also has a REST form, GET /cq1/quote, with the same key, scope, plan and rate:

```ts
const q = await carbium.cq1Quote({ src_mint: SOL, dst_mint: USDC, amount_in: '100000000', slippage_bps: 50 })
// one plain object, every value a string: q.destAmountOut, q.destAmountOutMin, q.priceImpactPct, q.routePlan
```

### Swap: quote, build, sign with your own wallet, send

The quote plane needs the account's quote module (free plan) and a key with the quote scope.

```ts
const quote = await carbium.quote.quote({ src_mint: SOL, dst_mint: USDC, amount_in: '100000000', slippage_bps: 50 })
const swap = await carbium.quote.swap({ quote_id: quote.quoteId, user_pubkey: wallet.address })
// swap.transaction is one unsigned v0 transaction, base64; your wallet is its only signer.
```

With `@solana/kit` 8:

```ts
import { getBase64Encoder, getTransactionDecoder, signTransaction, getBase64EncodedWireTransaction } from '@solana/kit'
const tx = getTransactionDecoder().decode(getBase64Encoder().encode(swap.transaction))
const signed = await signTransaction([keyPair], tx)
const signature = await carbium.rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true })
```

With `@solana/web3.js` 3:

```ts
import { VersionedTransaction } from '@solana/web3.js'
const tx = VersionedTransaction.deserialize(Buffer.from(swap.transaction, 'base64'))
tx.sign([keypair])
const signature = await carbium.rpc.sendTransaction(Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', skipPreflight: true })
```

Then poll `getSignatureStatuses` and resend the same bytes until the block height passes `swap.lastValidBlockHeight`.
The SDK never retries `sendTransaction`. Quote again (never re-sign the old message) when the blockhash expires or
when `swap` answers a route error that asks for a new quote (`-32095`, `-32074`, `-32081` to `-32083`, `-32096`, `-32093`).

## Errors and retries

Every failure is a `CarbiumError`. Check it with `isCarbiumError(e)`, not `instanceof` (a dual ESM and CJS install can
load two copies of the class).

| Field | Meaning |
|---|---|
| `kind` | `auth`, `credits`, `rate_limit`, `request`, `upstream`, `node`, `route`, `transport`, `socket`, `stream`, `account`, `dca`, `tokens`, `webhook` |
| `httpStatus` | the HTTP status, 0 when nothing answered |
| `code` | the JSON-RPC code, an HTTP API's error string, a gRPC status or a close code |
| `reason` | the door's `error.data.reason`, a close reason or a gRPC status name |
| `retryable` | whether waiting and sending the same request can change the answer |
| `retryAfterMs` | the server's wait hint |
| `requestId` | `x-request-id`, to quote to support |
| `data` | `error.data` as served |

The retry policy is the one published in skill.md and applies to every HTTP call on services.carbium.sh: wait the larger of the server's hint
(`retry-after-ms`, else `retryAfterMs` in the error's data, else `Retry-After`) and 250 ms doubling to 4 s, plus up to 250 ms of jitter; a hint is never cut, and a hint over `maxHintMs` (30 s by default) is not waited for: the error comes back at once with it in `retryAfterMs`;
at most 4 attempts unless the published row says otherwise (a scan index behind: about 6 from 100 ms). `sendTransaction`, 401, 402 (credits exhausted), 403, bad params (apart from `getTransactionsForAddress`'s `-32602` "the walk read no history", which is retried), unknown methods and every
answer marked `retryable: false` are never retried. `createCarbium({ retry: false })` turns retries off, and
`{ retry: { maxAttempts } }` lowers the attempt count. Keys never appear in error messages, data or logs.

## WebSocket subscriptions

```ts
const socket = carbium.socket({ onReseed: ({ gap }) => reloadStateOverRpc() })
const sub = socket.accountSubscribe(pubkey, (n) => console.log(n.context.slot, n.value.lamports), { commitment: 'confirmed' })
await sub.ready
await sub.unsubscribe()
```

All eight served subscriptions have a method (`accountSubscribe`, `programSubscribe`, `logsSubscribe`,
`signatureSubscribe`, `slotSubscribe`, `rootSubscribe`, `slotsUpdatesSubscribe`, `blockSubscribe`). The client
follows the server's close codes: it reconnects and binds every live subscription again after 1013, 1012, 1001 and
network drops, reconnects once after 1008 `credits_exhausted`, and stops with `onFatal` on a key refusal. Nothing is
replayed by the server after a disconnect: `onReseed` fires after every reconnect so you re-read what you may have
missed (`gap: true` after `stream_gap_reseed_required`). `signatureSubscribe` fires once; after a reconnect, check
`getSignatureStatuses`.

The key travels in the `Sec-WebSocket-Protocol` handshake header by default, which works in browsers and Node. In
Node you may pass the `ws` package (`new CarbiumSocket({ apiKey, WebSocket: ws, carrier: 'header' })`) to use the
`x-api-key` header and see handshake refusals by status. Any key used in a browser is visible to that page's user.

## Carbon Stream (Yellowstone gRPC, Node only)

Install the stock client beside the SDK: `npm install @triton-one/yellowstone-grpc`. The key needs the grpc scope and
a plan with streams. The stream client checks the server against the system's CA certificates, not the ones Node
bundles, so a slim image such as `node:24-slim` needs the `ca-certificates` package or `SSL_CERT_FILE` set to a CA bundle.

```ts
import { CarbiumStream } from '@carbium/sdk/stream'

const stream = await CarbiumStream.connect({ apiKey })
const live = stream.subscribeWithReconnect(
  { transactions: { pool: { accountInclude: [programId], accountExclude: [], accountRequired: [], vote: false, failed: false } } },
  {
    onUpdate: (u) => { if (u.transaction) handle(u.transaction) },
    onReseed: async ({ lastSlot }) => { await reloadOverRpc() },
  },
)
// later
live.close()
```

`subscribeWithReconnect` puts the whole filter set in the first message (a filter change needs a new stream), pings
every 10 s, retries with the published waits, re-seeds through `onReseed` on `OUT_OF_RANGE`, and resumes from the last
slot when the retained floor allows (a resume can replay one slot you already saw: dedupe on `(slot, signature)`); when
the floor is past the last slot or cannot be read, it re-seeds instead. A throw in `onUpdate` stops the stream: `done`
rejects with a `CarbiumError` carrying the thrown error as its `cause`.
Fields the service refuses (`tokenAccounts`, cuckoo filters, `includeUpdateParent`, `blockFooter`) are caught before
any call. The seven unary calls (`getSlot`, `getBlockHeight`, `getLatestBlockhash`, `isBlockhashValid`, `getVersion`,
`ping`, `subscribeReplayInfo`) are on the same object. `onUpdate` must not block: a reader that takes no frame for 10 s
is cut.

## Webhooks

```ts
import { verifyWebhook } from '@carbium/sdk/webhooks'

// in your HTTPS handler, with the RAW body bytes (never a re-encoded JSON string)
const events = await verifyWebhook(rawBody, request.headers, process.env.CARBIUM_WEBHOOK_SECRET ?? '')
```

Standard Webhooks: HMAC-SHA256 over `webhook-id.webhook-timestamp.body` with the secret's base64 after `whsec_`,
`v1,` entries in `webhook-signature` (two during a rotation), 300 s of clock tolerance. Throws a `CarbiumError` of kind
`webhook` with reason `missing_header`, `bad_timestamp`, `stale`, `bad_secret`, `no_match` or `bad_json`. Dedupe on
`webhook-id`: it stays the same across retries.

## Account API

An account API key (`c_acct_…`, made on the dashboard) runs the account by API: service keys, webhooks, usage and
records. Calls cost no credits; 600 per 10 minutes per key.

```ts
import { CarbiumAccount } from '@carbium/sdk/account'

const account = new CarbiumAccount({ apiKey: process.env.CARBIUM_ACCOUNT_KEY ?? '' })
const keys = await account.keys.list()
const { webhook, secret } = await account.webhooks.create({ key_id: keys[0]!.key_id, url: 'https://hooks.example.com/carbium', addresses: [wallet] })
const result = await account.webhooks.test(webhook.webhook_id) // read result.outcome
```

Groups: `keys` (list, create, rotate, revoke, delete, rename, setScope, setCaps, setAllowlist, setLimits), `webhooks`
(list, get, deliveries, create, update, delete, rotateSecret, test), `usage` (daily, perKey, load, hourly, latency),
`account` (get, balance, invoices, payments, modules, cryptoIntent), `modules.enableFree`, `self`, `activity`. Payments,
plan changes and making account keys stay on the dashboard.

## DCA API

```ts
import { CarbiumDca } from '@carbium/sdk/dca'

const dca = new CarbiumDca()
const quote = await dca.quote({ inputMint: USDC, outputMint: SOL, amount: '1000000' })
const build = await dca.open({ owner, inputMint: USDC, outputMint: SOL, cycles: 10, amountPerCycle: '1000000', frequency: 'daily' })
// build.txn_base64 is unsigned: sign it with the owner's wallet, then send it yourself or relay it:
const sent = await dca.send({ txn_base64: signedBase64 })
```

Reads: `quote`, `positions`, `history`, `position`, `health`. Builders: `open`, `update`, `withdraw`, `close`. `send`
relays bytes the owner signed. Server-side only: a browser page is refused with `forbidden_origin`. Errors are kind
`dca` with the API's `err` string as `code`.

## Token API

```ts
import { CarbiumTokens } from '@carbium/sdk/tokens'

const tokens = new CarbiumTokens()
const sol = await tokens.lookup('So11111111111111111111111111111111111111112')
const top = await tokens.search('', { limit: 20 })
const { items, unknown } = await tokens.batch(mints) // up to 500
const src = tokens.imageUrl(mint) // for an <img>
```

Keyless, browser-friendly, 300 requests a minute per client.

## Browsers

The core works in browsers with the same code. Only `x-request-id` and `retry-after` are readable across origins, so
the retry waits whole seconds there. `@carbium/sdk/stream` and the DCA API are server-side only.

## Limits the SDK checks before sending

Body 51,200 bytes; batch 1 to 100 calls with at most two permit methods; DAS only with DAS; scans, `getSupply`,
`getLargestAccounts`, the fee extras, `getTransactionsForAddress` and the quote plane never batch; a method the services
do not serve is refused before it is sent; `getMultipleAccounts` takes up to 300 pubkeys on PRO and
100 below it; `prices` up to 64 mints; token `batch` up to 500 mints.

MIT. Issues: https://github.com/carbium-sh/carbium-js/issues. Docs: https://carbium.sh/docs and https://carbium.sh/skill.md.
