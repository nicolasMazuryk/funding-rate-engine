/**
 * Bitget client construction (`08` §6 ccxt/native split). ccxt backs market metadata + REST
 * funding/account reads; the native `bitget-api` SDK (tiagosiebler — same author and idioms as
 * the `bybit-api` / `okx-api` libs the sibling adapters use) owns the hot-path WS, the WS-API
 * order path and the account-setup writes.
 *
 * Outside the core purity boundary, so `ccxt` / `bitget-api` imports are allowed here (the core
 * only ever sees the {@link ExchangeAdapter} port). The adapter depends on the narrow
 * {@link BitgetMarketClient} interface, not the concrete ccxt class, so a unit test injects a
 * fixture-backed fake and runs fully offline.
 *
 * Two Bitget divergences shape this file:
 *  - **UTA, explicitly.** The native `WebsocketAPIClient` (the WS order path) speaks only the
 *    v3 / Unified-Trading-Account surface, so this adapter targets v3 throughout — `RestClientV3`
 *    and `WebsocketClientV3`. On the ccxt side that means `options.uta: true` **set explicitly**:
 *    left `undefined`, ccxt probes the network (`handleUTAAndParams` → `GET /api/v3/account/settings`)
 *    on first use and silently falls back to the v2 mix endpoints for a non-UTA account. Pinned
 *    `true`, a non-UTA account fails loud instead.
 *  - **demo trading is a header, not a host or a product.** `demoTrading: true` on the native
 *    clients and ccxt's `setSandboxMode(true)` both add `PAPTRADING: 1` to the *same* REST host;
 *    only the WS host differs (`wspap` vs `ws`), and the SDK handles that. Bitget's separate
 *    `SUSDT-FUTURES` demo product — 3 symbols settled in `SUSDT` — belongs to the **v2 mix**
 *    API and is rejected outright by v3 (`40034 Parameter SUSDT-FUTURES does not exist`,
 *    probed live in task 0440). On v3/UTA, demo serves the ordinary `USDT-FUTURES` category
 *    with ordinary symbols (24 of them, `BTCUSDT` first), so nothing downstream branches:
 *    the universe filter, the balance asset and the `category` param are the same either way.
 *    Demo keys are demo-only — the live host answers them with `40099 exchange environment is
 *    incorrect`.
 */

import { RestClientV3, WebsocketAPIClient, WebsocketClientV3 } from 'bitget-api'
import {
  type Balances,
  bitget,
  type FundingHistory,
  type FundingRate,
  type FundingRateHistory,
  type FundingRates,
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
 * The real `ccxt.bitget` satisfies this structurally; tests supply a fake.
 */
export interface BitgetMarketClient {
  loadMarkets(): Promise<Record<string, MarketInterface | undefined>>
  /** Predicted funding for one symbol (`GET /api/v3/market/current-fund-rate`). */
  fetchFundingRate(symbol: string): Promise<FundingRate>
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number): Promise<FundingRateHistory[]>
  /** Bulk predicted-funding read — the public stream's fallback poll/reprime. */
  fetchFundingRates(symbols?: string[], params?: Record<string, unknown>): Promise<FundingRates>
  /** Last-price read for the public-stream tick REST fallback. */
  fetchTicker(symbol: string): Promise<Ticker>
  /** Account-wide open positions — private-stream reprime + degraded poll. */
  fetchPositions(symbols?: string[], params?: Record<string, unknown>): Promise<Position[]>
  /** Account balances (authoritative free/used) — private-stream reprime + `getBalance`. */
  fetchBalance(params?: Record<string, unknown>): Promise<Balances>
  /** Fill-poll one order by client id — Bitget takes `clientOid` as a param alongside the symbol. */
  fetchOrder(id: string, symbol?: string, params?: Record<string, unknown>): Promise<Order>
  /** Account-wide open orders — private-stream reprime + the stale reduce-only sweep. */
  fetchOpenOrders(symbol?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<Order[]>
  /**
   * Funding settlements (`fundingIncome` money truth). Unlike Bybit/OKX — where the credits
   * have to be filtered out of a generic `fetchLedger` — ccxt's Bitget `fetchFundingHistory`
   * has a real UTA branch (cursor-paginated financial records), so the rows arrive already
   * scoped to funding.
   */
  fetchFundingHistory(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>,
  ): Promise<FundingHistory[]>
}

/** ccxt (metadata/REST) + native (hot-path WS, orders, account setup) clients for one sub-account. */
export interface BitgetClients {
  readonly ccxt: BitgetMarketClient
  readonly native: RestClientV3
  /** Native public market-data WS (v3). Credential-free. */
  readonly wsPublic: WebsocketClientV3
  /** Native private account WS (v3, `instType: 'UTA'`). Credentialed — its own connection. */
  readonly wsPrivate: WebsocketClientV3
  /** Native WS-API order client: submit/cancel over the credentialed WS trade API. */
  readonly wsApiPrivate: WebsocketAPIClient
}

export interface CreateBitgetClientsOptions {
  /**
   * `'testnet'` flips every client into Bitget **demo trading** (the `PAPTRADING` header + the
   * `wspap` WS host). Default `'prod'`, matching the sibling factories' opt-in idiom.
   */
  readonly network?: 'prod' | 'testnet'
}

/** The three credentials Bitget signs with — the passphrase is not optional on this venue. */
function requirePassphrase(secrets: ParsedEnv['secrets']): string {
  const pass = secrets.apiPassphrase
  if (pass === undefined || pass.length === 0) {
    throw new Error(
      'Bitget credentials: BITGET_API_PASSPHRASE is required — Bitget signs every request with key + secret + passphrase',
    )
  }
  return pass
}

/**
 * Build the live ccxt + native clients for a Bitget instance. `defaultType: 'swap'` makes
 * `loadMarkets()` return the derivatives universe the `10` §3 filter narrows to the product's
 * linear settle asset.
 *
 * `opts.network: 'testnet'` selects demo trading — a flag plus a product type on the same
 * account, see the file header — so the swap stays data, not a code branch.
 */
export function createBitgetClients(
  _profile: ExchangeProfile,
  secrets: ParsedEnv['secrets'],
  opts: CreateBitgetClientsOptions = {},
): BitgetClients {
  // `_profile` is threaded through per the venue-profile contract; the rate-limit budget it
  // carries is consumed by `createBitgetRateLimiter`, not by the clients themselves.
  const demoTrading = opts.network === 'testnet'
  const apiPass = requirePassphrase(secrets)

  const ccxtClient = new bitget({
    apiKey: secrets.apiKey,
    secret: secrets.apiSecret,
    password: apiPass, // ccxt's name for the Bitget passphrase
    enableRateLimit: true,
    // `uta: true` is explicit on purpose — see the file header: left undefined, ccxt probes the
    // account over the network and silently routes a non-UTA account to the v2 mix endpoints.
    options: { defaultType: 'swap', uta: true },
  })
  if (demoTrading) ccxtClient.setSandboxMode(true)

  const credentials = { apiKey: secrets.apiKey, apiSecret: secrets.apiSecret, apiPass }
  const native = new RestClientV3({ ...credentials, demoTrading })
  const wsPublic = new WebsocketClientV3({ demoTrading })
  // Credentialed twin for the private account stream: the lib owns auth, keepalive, reconnect
  // and resubscribe for the `order`/`fill`/`position`/`account` topics.
  const wsPrivate = new WebsocketClientV3({ ...credentials, demoTrading })
  // Credentialed WS-API order client. Its own connection; the SDK signs each request and
  // manages the socket. `attachEventListeners: false` — we do our own logging, and the lib's
  // default listeners console.log every frame.
  //
  // `authPrivateConnectionsOnConnect: false` repeats the OKX lesson: the SDK's on-connect login
  // can fire while the socket is still `CONNECTING` ("WebSocket is not open: readyState 0"),
  // which cost one submit its whole retry budget in a task 0440 Phase 2 demo run. This client
  // subscribes to **no** topics, so the login `sendWSAPIRequest` performs on first use is enough
  // — unlike `wsPrivate` above, where auth-on-connect is what gates the private topic
  // subscriptions and must stay on. The flag is honoured by the SDK's runtime options merge but
  // declared only on its internal options type, hence the cast.
  const wsApiPrivate = new WebsocketAPIClient({
    ...credentials,
    demoTrading,
    attachEventListeners: false,
    authPrivateConnectionsOnConnect: false,
  } as ConstructorParameters<typeof WebsocketAPIClient>[0])

  return { ccxt: ccxtClient, native, wsPublic, wsPrivate, wsApiPrivate }
}

/**
 * Build the per-exchange weighted rate limiter from the venue profile budget (`10` §6).
 * A helper, not wired at construction — composition stays injectable: the caller passes the
 * returned limiter into `createBitgetAdapter({ limiter })`.
 *
 * Bitget has no weight model either (see the `rate_limit_weight_per_minute` derivation comment
 * in `config/exchanges.yaml`), so every call draws weight 1; the profile's 1700/min at a 35 %
 * reserve is what keeps both lanes under the venue's per-UID caps (10 orders/s, 20 reads/s).
 */
export function createBitgetRateLimiter(profile: ExchangeProfile, clock: Clock): RateLimiter {
  const args = budgetToLimiterArgs({
    weightPerMinute: profile.rateLimitWeightPerMinute,
    reservePct: profile.rateLimitReservePct,
  })
  return createRateLimiter({ ...args, clock })
}
