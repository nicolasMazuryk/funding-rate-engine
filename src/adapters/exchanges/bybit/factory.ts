/**
 * Bybit client construction (`08` §6 ccxt/native split). ccxt backs market metadata +
 * REST funding/account reads; the native `bybit-api` SDK (tiagosiebler — same author and
 * idioms as the `binance` lib the sibling adapter uses) owns the hot-path WS and the
 * account-setup writes.
 *
 * Outside the core purity boundary, so `ccxt` / `bybit-api` imports are allowed here (the
 * core only ever sees the {@link ExchangeAdapter} port). The adapter depends on the narrow
 * {@link BybitMarketClient} interface, not the concrete ccxt class, so a unit test injects
 * a fixture-backed fake and runs fully offline.
 *
 * Bybit divergences from the Binance factory:
 *  - one ccxt class for every category (`ccxt.bybit` with `defaultType: 'swap'`), and
 *    `setSandboxMode(true)` **is** supported — no manual `urls.test` merge;
 *  - no `fetchFundingIntervals` (a Binance-only helper): Bybit's interval ships inside
 *    `market.info.fundingInterval`, so the registry load is a single call;
 *  - `fetchLedger` is in the slice — it is the real `fundingIncome` source
 *    (`/v5/account/transaction-log`, `type=SETTLEMENT`), which Binance still stubs.
 */

import { RestClientV5, WebsocketAPIClient, WebsocketClient } from 'bybit-api'
import {
  type Balances,
  bybit,
  type FundingRate,
  type FundingRateHistory,
  type FundingRates,
  type LedgerEntry,
  type MarketInterface,
  type Order,
  type Position,
  type Ticker,
} from 'ccxt'
import type { ParsedEnv } from '../../../config/env.js'
import type { ExchangeProfile } from '../../../config/exchange-schema.js'
import type { Clock } from '../../../core/ports/clock.js'
import { budgetToLimiterArgs, createRateLimiter, type RateLimiter } from '../../shared/rate-limiter.js'

/**
 * The slice of ccxt the adapter actually calls — market metadata + funding/account REST.
 * The real `ccxt.bybit` satisfies this structurally; tests supply a fake.
 */
export interface BybitMarketClient {
  loadMarkets(): Promise<Record<string, MarketInterface | undefined>>
  /** Emulated on Bybit (ccxt derives it from `/v5/market/tickers`) — still the `predictedFunding` read. */
  fetchFundingRate(symbol: string): Promise<FundingRate>
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number): Promise<FundingRateHistory[]>
  /** Bulk predicted-funding read — the public stream's fallback poll/reprime in one call. */
  fetchFundingRates(symbols?: string[], params?: Record<string, unknown>): Promise<FundingRates>
  /** Last-price read for the public-stream tick REST fallback. */
  fetchTicker(symbol: string): Promise<Ticker>
  /** Account-wide open positions — private-stream reprime + degraded poll. */
  fetchPositions(symbols?: string[], params?: Record<string, unknown>): Promise<Position[]>
  /** Account balances (authoritative free/used) — private-stream reprime + `getBalance`. */
  fetchBalance(params?: Record<string, unknown>): Promise<Balances>
  /** Fill-poll one order by client id — `getOrder`; Bybit requires a symbol + `orderLinkId`. */
  fetchOrder(id: string, symbol?: string, params?: Record<string, unknown>): Promise<Order>
  /** Account-wide open orders — private-stream reprime + the stale reduce-only sweep. */
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Order[]>
  /**
   * Account transaction log (`/v5/account/transaction-log`) — the `fundingIncome` money
   * truth (`type=SETTLEMENT`, `info.funding`, **positive = received**).
   */
  fetchLedger(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<LedgerEntry[]>
}

/** ccxt (metadata/REST) + native (hot-path WS, account setup) clients for one Bybit sub-account. */
export interface BybitClients {
  readonly ccxt: BybitMarketClient
  readonly native: RestClientV5
  /** Native public market-data WS. Credential-free. */
  readonly wsPublic: WebsocketClient
  /** Native private account WS. Credentialed — its own connection, distinct from {@link wsPublic}. */
  readonly wsPrivate: WebsocketClient
  /** Native WS-API order client: submit/cancel over the credentialed WS trade API. */
  readonly wsApiPrivate: WebsocketAPIClient
}

export interface CreateBybitClientsOptions {
  /** `'testnet'` points every client at the Bybit testnet (task 0420 DoD step 3). Default `'prod'`. */
  readonly network?: 'prod' | 'testnet'
}

/**
 * Build the live ccxt + native clients for a Bybit instance. `defaultType: 'swap'` makes
 * `loadMarkets()` return the derivatives universe the `10` §3 filter narrows to linear
 * USDT perps.
 *
 * `opts.network: 'testnet'` (default `'prod'`, matching the Binance opt-in idiom) calls
 * ccxt's `setSandboxMode(true)` and flips `testnet: true` on the three native clients —
 * the base-URL swap stays data, not a code branch.
 */
export function createBybitClients(
  _profile: ExchangeProfile,
  secrets: ParsedEnv['secrets'],
  opts: CreateBybitClientsOptions = {},
): BybitClients {
  // `_profile` is threaded through per the venue-profile contract; the rate-limit budget it
  // carries is consumed by `createBybitRateLimiter`, not by the clients themselves.
  const testnet = opts.network === 'testnet'
  const ccxtClient = new bybit({
    apiKey: secrets.apiKey,
    secret: secrets.apiSecret,
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  })
  if (testnet) ccxtClient.setSandboxMode(true)

  // `throwExceptions: true` is load-bearing: the lib **resolves** a non-zero `retCode` by
  // default, so without it a rejected order or a rate-limit reply would look like success.
  // With it, the raw body (carrying `retCode`) is thrown and `error-map.ts` classifies it.
  const native = new RestClientV5({
    key: secrets.apiKey,
    secret: secrets.apiSecret,
    throwExceptions: true,
    ...(testnet ? { testnet } : {}),
  })
  const wsPublic = new WebsocketClient({ ...(testnet ? { testnet } : {}) })
  // Credentialed twin for the private account stream: the lib owns auth, keepalive,
  // reconnect and resubscribe for the `order`/`execution`/`position`/`wallet` topics.
  const wsPrivate = new WebsocketClient({
    key: secrets.apiKey,
    secret: secrets.apiSecret,
    ...(testnet ? { testnet } : {}),
  })
  // Credentialed WS-API order client. Its own connection; the SDK signs each request and
  // manages the socket. `attachEventListeners: false` — we do our own logging, and the
  // lib's default listeners console.log every frame.
  const wsApiPrivate = new WebsocketAPIClient({
    key: secrets.apiKey,
    secret: secrets.apiSecret,
    attachEventListeners: false,
    ...(testnet ? { testnet } : {}),
  })
  return { ccxt: ccxtClient, native, wsPublic, wsPrivate, wsApiPrivate }
}

/**
 * Build the per-exchange weighted rate limiter from the venue profile budget (`10` §6).
 * A helper, not wired at construction — composition stays injectable: the caller passes
 * the returned limiter into `createBybitAdapter({ limiter })`.
 *
 * Bybit has no weight model (see the `rate_limit_weight_per_minute` derivation comment in
 * `config/exchanges.yaml`), so every call below draws weight 1 and the profile's 6000/min
 * budget is what makes the reserved order lane land on the venue's true 10 orders/s cap.
 */
export function createBybitRateLimiter(profile: ExchangeProfile, clock: Clock): RateLimiter {
  const args = budgetToLimiterArgs({
    weightPerMinute: profile.rateLimitWeightPerMinute,
    reservePct: profile.rateLimitReservePct,
  })
  return createRateLimiter({ ...args, clock })
}
