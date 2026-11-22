/**
 * TypeScript client for Carbium's Solana services on services.carbium.sh: JSON-RPC (Solana RPC and DAS), WebSocket subscriptions, quote and swap, webhooks, the account API, DCA and the token API.
 * Swap and DCA calls build one unsigned transaction for your own wallet. The SDK never holds a private key, signs or sends on its own.
 * @module
 */
export { CarbiumError, isCarbiumError, redactSecrets, type CarbiumErrorInit, type CarbiumErrorKind } from './errors.ts'
export { decideRetry, backoffDelayMs, serverHintMs, type RetryOptions, type RetryPlan, type RetryContext } from './retry.ts'
export { JsonRpcTransport, LIMITS, DEFAULT_ENDPOINT, type ClientOptions, type CallOptions, type JsonRpcCall, type BatchResult } from './transport.ts'
export { METHODS, SUBSCRIPTIONS, type MethodName, type MethodTable, type MethodSpec, type Plane, type SubscriptionName } from './rpc/methods.gen.ts'
export * from './rpc/types.ts'
export { createCarbium, type Carbium, type RpcApi, type DasApi, type QuoteApi, type TypedCall, type ParamsOf, type ResultOf } from './rpc/client.ts'
export { CarbiumSocket, type LogsFilter, type BlockFilter, type SettledCommitment, type BlockEncoding, type BlockSubscribeDetails, type ProgramSubscribeFilter, type SocketOptions, type Subscription, type SubscriptionMethods, type SocketState, type CloseInfo, type WebSocketLike, type WebSocketConstructor } from './ws.ts'
export { CarbiumAccount, CarbiumSession, type AccountOptions, type SessionOptions, type Terms, type SignupChallenge, type ProofOfWork, type SessionAccount, type SessionResult } from './account.ts'
export * from './account-types.ts'
export { CarbiumDca, type DcaOptions } from './dca.ts'
export * from './dca-types.ts'
export { CarbiumTokens, type TokensOptions } from './tokens.ts'
export * from './tokens-types.ts'
export { verifyWebhook, verifyWebhookSignature, type WebhookEvent, type WebhookHeaders, type VerifyWebhookOptions } from './webhooks.ts'
export { VERSION } from './version.ts'
