/**
 * OKX client construction (`08` §6 ccxt/native split). ccxt backs market metadata + REST
 * funding/account reads; the native `okx-api` SDK (tiagosiebler — same author and idioms as
 * the `bybit-api` / `binance` libs the sibling adapters use) owns the hot-path WS and the
 * account-setup writes.
 *
 * Outside the core purity boundary, so `ccxt` / `okx-api` imports are allowed here (the core
 * only ever sees the {@link ExchangeAdapter} port). The adapter depends on the narrow
 * {@link OkxMarketClient} interface, not the concrete ccxt class, so a unit test injects a
 * fixture-backed fake and runs fully offline.
 *
 * OKX divergences from the Bybit factory:
 *  - **the passphrase**. OKX signs with a third credential (`apiPass`), chosen when the key
 *    is created. `09` §2 has parsed `${EXCHANGE}_API_PASSPHRASE` since task 0100 and
 *    `src/config/redaction.ts` has listed `*_PASSPHRASE` just as long, but this is the first
 *    factory to actually read it — so it fails loud when absent rather than building clients
 *    that would 50104/50105 on the first signed call;
 *  - **demo trading is a flag, not a network**. There is no separate testnet domain or
 *    signup: `demoTrading: true` on the native clients and ccxt's `setSandboxMode(true)`
 *    (which adds the `x-simulated-trading: 1` header) point the *same* account's keys at the
 *    demo book. Only the WS host differs (`wspap` vs `ws`), and the SDK handles that.
 */

import {
  type Balances,
  type FundingRate,
  type FundingRateHistory,
  type FundingRates,
  type LedgerEntry,
  type MarketInterface,
  type Order,
  okx,
  type Position,
  type Ticker,
} from 'ccxt'
import { RestClient, WebsocketAPIClient, WebsocketClient } from 'okx-api'
import type { ParsedEnv } from '../../../config/env.js'
import type { ExchangeProfile } from '../../../config/exchange-schema.js'
import type { Clock } from '../../../core/ports/clock.js'
import { budgetToLimiterArgs, createRateLimiter, type RateLimiter } from '../../shared/rate-limiter.js'

/**
 * The slice of ccxt the adapter actually calls — market metadata + funding/account REST.
 * The real `ccxt.okx` satisfies this structurally; tests supply a fake.
 */
export interface OkxMarketClient {
  loadMarkets(): Promise<Record<string, MarketInterface | undefined>>
  /** `GET /api/v5/public/funding-rate` — predicted funding **and** the interval source (`instrument.ts`). */
  fetchFundingRate(symbol: string): Promise<FundingRate>
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number): Promise<FundingRateHistory[]>
  /** Bulk predicted-funding read — the public stream's fallback poll/reprime, and the interval derivation. */
  fetchFundingRates(symbols?: string[], params?: Record<string, unknown>): Promise<FundingRates>
  /** Last-price read for the public-stream tick REST fallback. */
  fetchTicker(symbol: string): Promise<Ticker>
  /** Account-wide open positions — private-stream reprime + degraded poll. */
  fetchPositions(symbols?: string[], params?: Record<string, unknown>): Promise<Position[]>
  /** Account balances (authoritative free/used) — private-stream reprime + `getBalance`. */
  fetchBalance(params?: Record<string, unknown>): Promise<Balances>
  /** Fill-poll one order by client id — OKX takes `clOrdId` as a param alongside the instId. */
  fetchOrder(id: string, symbol?: string, params?: Record<string, unknown>): Promise<Order>
  /** Account-wide open orders — private-stream reprime + the stale reduce-only sweep. */
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Order[]>
  /**
   * Account bills (`GET /api/v5/account/bills`) — the `fundingIncome` money truth
   * (funding-fee bill type, **positive = received**), as on Bybit.
   */
  fetchLedger(code?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<LedgerEntry[]>
}

/** ccxt (metadata/REST) + native (hot-path WS, account setup) clients for one OKX sub-account. */
export interface OkxClients {
  readonly ccxt: OkxMarketClient
  readonly native: RestClient
  /** Native public market-data WS. Credential-free. */
  readonly wsPublic: WebsocketClient
  /** Native private account WS. Credentialed — its own connection, distinct from {@link wsPublic}. */
  readonly wsPrivate: WebsocketClient
  /** Native WS-API order client: submit/cancel over the credentialed WS trade API. */
  readonly wsApiPrivate: WebsocketAPIClient
}

export interface CreateOkxClientsOptions {
  /**
   * `'testnet'` flips every client into OKX **demo trading** (task 0430 DoD step 3).
   * Default `'prod'`, matching the sibling factories' opt-in idiom.
   */
  readonly network?: 'prod' | 'testnet'
}

/** The three credentials OKX signs with — the passphrase is not optional on this venue. */
function requirePassphrase(secrets: ParsedEnv['secrets']): string {
  const pass = secrets.apiPassphrase
  if (pass === undefined || pass.length === 0) {
    throw new Error(
      'OKX credentials: OKX_API_PASSPHRASE is required — OKX signs every request with key + secret + passphrase',
    )
  }
  return pass
}

/**
 * Build the live ccxt + native clients for an OKX instance. `defaultType: 'swap'` makes
 * `loadMarkets()` return the derivatives universe the `10` §3 filter narrows to linear
 * USDT-settled perps.
 *
 * `opts.network: 'testnet'` selects demo trading — a flag on the same account, see the file
 * header — so the swap stays data, not a code branch.
 */
export function createOkxClients(
  _profile: ExchangeProfile,
  secrets: ParsedEnv['secrets'],
  opts: CreateOkxClientsOptions = {},
): OkxClients {
  // `_profile` is threaded through per the venue-profile contract; the rate-limit budget it
  // carries is consumed by `createOkxRateLimiter`, not by the clients themselves.
  const demoTrading = opts.network === 'testnet'
  const apiPass = requirePassphrase(secrets)

  const ccxtClient = new okx({
    apiKey: secrets.apiKey,
    secret: secrets.apiSecret,
    password: apiPass, // ccxt's name for the OKX passphrase
    enableRateLimit: true,
    options: { defaultType: 'swap' },
  })
  if (demoTrading) ccxtClient.setSandboxMode(true)

  const credentials = { apiKey: secrets.apiKey, apiSecret: secrets.apiSecret, apiPass }
  const native = new RestClient({ ...credentials, demoTrading })
  const wsPublic = new WebsocketClient({ demoTrading })
  // Credentialed twin for the private account stream: the lib owns auth, keepalive,
  // reconnect and resubscribe for the `orders`/`positions`/`account` channels.
  const wsPrivate = new WebsocketClient({ accounts: [credentials], demoTrading })
  // Credentialed WS-API order client. Its own connection; the SDK signs each request and
  // manages the socket. `attachEventListeners: false` — we do our own logging, and the
  // lib's default listeners console.log every frame.
  //
  // `authPrivateConnectionsOnConnect: false` is load-bearing, not a preference (observed live,
  // task 0430): the lib otherwise logs in twice on this connection — once from its own
  // on-connect hook, once from `sendWSAPIRequest`'s `assertIsAuthenticated`, which races the
  // first. OKX answers the second with `60031 "The WebSocket endpoint does not allow multiple
  // or repeated logins"` and **closes the socket**, so every order ends in a `WsTimeout` and
  // an endless reconnect loop. With the on-connect hook off, the single login is the one
  // `sendWSAPIRequest` awaits before sending — which is exactly the ordering we need, and this
  // client subscribes to no topics, so nothing else depends on the hook.
  //
  // The flag lives on the lib's *internal* options type (it merges user options over its
  // defaults at construction), so it is passed through a cast rather than being absent.
  const wsApiPrivate = new WebsocketAPIClient({
    accounts: [credentials],
    demoTrading,
    attachEventListeners: false,
    authPrivateConnectionsOnConnect: false,
  } as ConstructorParameters<typeof WebsocketAPIClient>[0])
  return { ccxt: ccxtClient, native, wsPublic, wsPrivate, wsApiPrivate }
}

/**
 * Build the per-exchange weighted rate limiter from the venue profile budget (`10` §6).
 * A helper, not wired at construction — composition stays injectable: the caller passes the
 * returned limiter into `createOkxAdapter({ limiter })`.
 *
 * OKX has no weight model either (see the `rate_limit_weight_per_minute` derivation comment
 * in `config/exchanges.yaml`), so every call draws weight 1; the profile's 1200/min at a 50%
 * reserve is what makes both lanes land on the venue's true per-endpoint and per-instrument
 * caps.
 */
export function createOkxRateLimiter(profile: ExchangeProfile, clock: Clock): RateLimiter {
  const args = budgetToLimiterArgs({
    weightPerMinute: profile.rateLimitWeightPerMinute,
    reservePct: profile.rateLimitReservePct,
  })
  return createRateLimiter({ ...args, clock })
}
