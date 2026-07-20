/**
 * Binance client construction (`08` §6 ccxt/native split). ccxt backs market
 * metadata + REST fallback; the native `binance` SDK (tiagosiebler) owns the
 * hot-path WS added in 0210/0220 — constructed here now so the wiring exists, but
 * unused until then.
 *
 * Outside the core purity boundary, so `ccxt` / `binance` imports are allowed here
 * (the core only ever sees the {@link ExchangeAdapter} port). The adapter depends on
 * the narrow {@link BinanceMarketClient} interface, not the concrete ccxt class, so a
 * unit test injects a fixture-backed fake and runs fully offline.
 */

import { USDMClient, WebsocketClient } from 'binance'
import { binanceusdm, type FundingRate, type FundingRateHistory, type MarketInterface, type Ticker } from 'ccxt'
import type { ParsedEnv } from '../../../config/env.js'
import type { ExchangeProfile } from '../../../config/exchange-schema.js'
import type { Clock } from '../../../core/ports/clock.js'
import { budgetToLimiterArgs, createRateLimiter, type RateLimiter } from '../../shared/rate-limiter.js'

/**
 * The slice of ccxt the adapter actually calls — market metadata + funding REST.
 * The real `ccxt.binanceusdm` satisfies this structurally; tests supply a fake.
 */
export interface BinanceMarketClient {
  loadMarkets(): Promise<Record<string, MarketInterface | undefined>>
  fetchFundingRate(symbol: string): Promise<FundingRate>
  fetchFundingRateHistory(symbol: string, since?: number, limit?: number): Promise<FundingRateHistory[]>
  /** Last-price read for the public-stream tick REST fallback (0210). */
  fetchTicker(symbol: string): Promise<Ticker>
}

/** ccxt (metadata/REST) + native (hot-path WS, 0210+) clients for one Binance sub-account. */
export interface BinanceClients {
  readonly ccxt: BinanceMarketClient
  readonly native: USDMClient
  /** Native public market-data WS (0210). Credential-free; unused until the adapter wires it. */
  readonly wsPublic: WebsocketClient
}

/**
 * Build the live ccxt + native clients for a Binance instance. `binanceusdm` is the
 * USDT-margined linear-perp venue class, so `loadMarkets()` returns exactly the perp
 * universe the `10` §3 filter narrows. Rate limiting is left to ccxt for now; the
 * mapped taxonomy + token bucket are 0200.
 */
export function createBinanceClients(_profile: ExchangeProfile, secrets: ParsedEnv['secrets']): BinanceClients {
  // `_profile` is threaded through per the venue-profile contract but carries nothing
  // ccxt needs yet — rate-limit reserve / stagger wire in with the taxonomy (0200).
  const ccxtClient = new binanceusdm({
    apiKey: secrets.apiKey,
    secret: secrets.apiSecret,
    enableRateLimit: true,
    // `fetchCurrencies: false` — loadMarkets otherwise hits a *signed* sapi endpoint
    // for currencies the perp adapter never uses, so the public market load stays
    // credential-free (linear USDT perps need only public fapi exchangeInfo).
    options: { defaultType: 'swap', fetchCurrencies: false },
  })
  const native = new USDMClient({ api_key: secrets.apiKey, api_secret: secrets.apiSecret })
  // `beautify: true` → the client emits `formattedMessage` events the public stream reads.
  const wsPublic = new WebsocketClient({ beautify: true })
  return { ccxt: ccxtClient, native, wsPublic }
}

/**
 * Build the per-exchange weighted rate limiter from the venue profile budget (`10` §6).
 * A helper, not wired at construction — there is no `main.ts` yet, so composition stays
 * injectable: the caller passes the returned limiter into `createBinanceAdapter({ limiter })`.
 */
export function createBinanceRateLimiter(profile: ExchangeProfile, clock: Clock): RateLimiter {
  const args = budgetToLimiterArgs({
    weightPerMinute: profile.rateLimitWeightPerMinute,
    reservePct: profile.rateLimitReservePct,
  })
  return createRateLimiter({ ...args, clock })
}
