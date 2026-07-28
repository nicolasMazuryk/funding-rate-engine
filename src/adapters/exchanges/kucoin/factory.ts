/**
 * KuCoin Futures client construction (`08` §6 ccxt/native split). ccxt backs market metadata +
 * REST funding/account reads; the native `kucoin-api` SDK (tiagosiebler — same author and idioms
 * as the `bybit-api` / `okx-api` / `bitget-api` libs the sibling adapters use, so ROADMAP A5
 * needs no substitution here) owns the hot-path WS, the WS-API order path and the account-setup
 * writes.
 *
 * Outside the core purity boundary, so `ccxt` / `kucoin-api` imports are allowed here (the core
 * only ever sees the {@link ExchangeAdapter} port). The adapter depends on the narrow
 * {@link KucoinMarketClient} interface, not the concrete ccxt class, so a unit test injects a
 * fixture-backed fake and runs fully offline.
 *
 * Three KuCoin divergences shape this file:
 *
 *  - **the ccxt class is `kucoinfutures`, not `kucoin`.** `ccxt.kucoin` is the *spot* exchange:
 *    built with it, `loadMarkets()` returns spot pairs, every derivatives read 404s, and the
 *    `10` §3 filter would simply produce an empty universe rather than an error. KuCoin is the
 *    first split-class venue in this repo.
 *
 *  - **there is no `network` / sandbox option at all** — deliberately, not as an oversight and
 *    not as a no-op branch. KuCoin decommissioned its futures sandbox: `ccxt.kucoinfutures`
 *    carries no `urls.test`, and `setSandboxMode(true)` **does not throw** — it silently sets
 *    `urls.api = {}`, so every later call fails with an unrelated URL error far from the cause.
 *    Offering an option that can only misfire is worse than not offering one, so the venue's
 *    verification tier is read-only against the live host instead (`src/testnet/kucoin/`).
 *    `factory.test.ts` pins both halves of this as a regression guard.
 *
 *  - **the WS endpoint is discovered, not configured.** KuCoin hands out a per-connection
 *    bullet token (`POST /api/v1/bullet-public|private`) whose reply carries the real
 *    `instanceServers[].endpoint`. The SDK does that handshake internally, keyed by `wsKey`
 *    (`futuresPublicV1` / `futuresPrivateV1`), and emits the same `open`/`reconnect`/
 *    `reconnected`/`close`/`update` events as the other three tiagosiebler SDKs — so
 *    `src/adapters/shared/reconnect.ts` needs no `connect(): Promise<Endpoint>` hook and is
 *    reused verbatim (a deliberate deviation from task 0460's implementation note, recorded in
 *    STATUS).
 */

import {
  type Balances,
  type FundingHistory,
  type FundingRate,
  type FundingRateHistory,
  kucoinfutures,
  type MarketInterface,
  type Order,
  type Position,
  type Ticker,
  type Trade,
} from 'ccxt'
import { FuturesClient, WebsocketAPIClient, WebsocketClient } from 'kucoin-api'
import type { ParsedEnv } from '../../../config/env.js'
import type { ExchangeProfile } from '../../../config/exchange-schema.js'
import type { Clock } from '../../../core/ports/clock.js'
import { budgetToLimiterArgs, createRateLimiter, type RateLimiter } from '../../shared/rate-limiter.js'

/**
 * The slice of ccxt the adapter actually calls — market metadata + funding/account REST.
 * The real `ccxt.kucoinfutures` satisfies this structurally; tests supply a fake.
 *
 * Note what is **absent**: `fetchFundingRates`. `kucoinfutures.has.fetchFundingRates` is `false`
 * — KuCoin publishes no bulk predicted-funding read — so the public stream's degraded-mode
 * fallback fans out per symbol instead (`./public-stream.ts`), the one place this venue costs
 * more requests than its siblings.
 */
export interface KucoinMarketClient {
  loadMarkets(): Promise<Record<string, MarketInterface | undefined>>
  /** Predicted funding for one symbol (`GET /api/v1/funding-rate/{symbol}/current`). */
  fetchFundingRate(symbol: string): Promise<FundingRate>
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number): Promise<FundingRateHistory[]>
  /** Last-price read for the public-stream tick REST fallback. */
  fetchTicker(symbol: string): Promise<Ticker>
  /** Account-wide open positions — private-stream reprime + degraded poll. */
  fetchPositions(symbols?: string[], params?: Record<string, unknown>): Promise<Position[]>
  /** Account balances (authoritative free/used) — private-stream reprime + `getBalance`. */
  fetchBalance(params?: Record<string, unknown>): Promise<Balances>
  /** Fill-poll one order by client id — KuCoin reads it directly (`{ clientOid }`, no symbol). */
  fetchOrder(id: string, symbol?: string, params?: Record<string, unknown>): Promise<Order>
  /** Account-wide open orders — private-stream reprime + the stale reduce-only sweep. */
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Order[]>
  /**
   * Executions of one order (`GET /api/v1/fills`) — the **only** place KuCoin reports a
   * realized commission; the order row itself carries no fee (observed live, 0470 §6).
   */
  fetchMyTrades(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Trade[]>
  /**
   * Funding settlements (`fundingIncome` money truth). `kucoinfutures.has.fetchFundingHistory`
   * is `true` with a real implementation (`GET /api/v1/funding-history`), so the rows arrive
   * already scoped to funding — no ledger/bill-type filter (Bybit, OKX).
   */
  fetchFundingHistory(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>,
  ): Promise<FundingHistory[]>
}

/** ccxt (metadata/REST) + native (hot-path WS, orders, account setup) clients for one sub-account. */
export interface KucoinClients {
  readonly ccxt: KucoinMarketClient
  readonly native: FuturesClient
  /** Native public market-data WS. Credential-free (public bullet token). */
  readonly wsPublic: WebsocketClient
  /** Native private account WS. Credentialed — its own connection and private bullet token. */
  readonly wsPrivate: WebsocketClient
  /** Native WS-API order client: submit/cancel over the credentialed WS trade API. */
  readonly wsApiPrivate: WebsocketAPIClient
}

/** The three credentials KuCoin signs with — the passphrase is not optional on this venue. */
function requirePassphrase(secrets: ParsedEnv['secrets']): string {
  const pass = secrets.apiPassphrase
  if (pass === undefined || pass.length === 0) {
    throw new Error(
      'KuCoin credentials: KUCOIN_API_PASSPHRASE is required — KuCoin signs every request with key + secret + passphrase',
    )
  }
  return pass
}

/**
 * Build the live ccxt + native clients for a KuCoin instance. `defaultType: 'swap'` makes
 * `loadMarkets()` return the derivatives universe the `10` §3 filter narrows to linear
 * USDT-settled perpetuals.
 *
 * There is no environment parameter — see the file header: KuCoin has no futures sandbox and
 * `setSandboxMode` fails silently, so a `network` option could only ever produce a broken
 * client.
 */
export function createKucoinClients(_profile: ExchangeProfile, secrets: ParsedEnv['secrets']): KucoinClients {
  // `_profile` is threaded through per the venue-profile contract; the rate-limit budget it
  // carries is consumed by `createKucoinRateLimiter`, not by the clients themselves.
  const apiPassphrase = requirePassphrase(secrets)

  const ccxtClient = new kucoinfutures({
    apiKey: secrets.apiKey,
    secret: secrets.apiSecret,
    password: apiPassphrase, // ccxt's name for the KuCoin passphrase
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  })

  const credentials = { apiKey: secrets.apiKey, apiSecret: secrets.apiSecret, apiPassphrase }
  const native = new FuturesClient(credentials)
  const wsPublic = new WebsocketClient({})
  // Credentialed twin for the private account stream: the lib owns the private bullet token,
  // keepalive, reconnect and resubscribe for the order/position/wallet topics.
  const wsPrivate = new WebsocketClient(credentials)
  // Credentialed WS-API order client. Its own connection; the SDK signs each request and manages
  // the socket. `attachEventListeners: false` — we do our own logging, and the lib's default
  // listeners console.log every frame.
  const wsApiPrivate = new WebsocketAPIClient({ ...credentials, attachEventListeners: false })

  return { ccxt: ccxtClient, native, wsPublic, wsPrivate, wsApiPrivate }
}

/**
 * Build the per-exchange weighted rate limiter from the venue profile budget (`10` §6).
 * A helper, not wired at construction — composition stays injectable: the caller passes the
 * returned limiter into `createKucoinAdapter({ limiter })`.
 *
 * KuCoin is the **first venue with a real per-endpoint weight model** (Bybit/OKX/Bitget publish
 * request counts, so every call there costs 1). The budget derivation lives in the
 * `rate_limit_weight_per_minute` comment in `config/exchanges.yaml`; the per-endpoint weights
 * the adapter draws live in `./adapter.ts`.
 */
export function createKucoinRateLimiter(profile: ExchangeProfile, clock: Clock): RateLimiter {
  const args = budgetToLimiterArgs({
    weightPerMinute: profile.rateLimitWeightPerMinute,
    reservePct: profile.rateLimitReservePct,
  })
  return createRateLimiter({ ...args, clock })
}
