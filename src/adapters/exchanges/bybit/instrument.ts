/**
 * ccxt `Market` → validated {@link Instrument} mapping + the `10` §3 filter for Bybit —
 * pure, no I/O (the ccxt market object is passed in). Mirrors
 * `../binance/instrument.ts`: any anomaly **throws** and aborts startup rather than
 * trading on a bad instrument (a wrong `contractSize` silently mis-sizes every order,
 * `10` §4).
 *
 * Bybit-specific:
 *  - the funding interval ships **inside `market.info.fundingInterval`, in minutes**
 *    (240 / 480 / 60 on the live linear listing), so `fundingIntervalHours =
 *    fundingInterval / 60` — no second REST call (Binance needs `fapi/v1/fundingInfo`);
 *  - `0` minutes marks the dated `LinearFutures` rows, which the `swap` filter already
 *    drops — if one ever reaches here it fails the {1,2,4,8} validation, fail-loud;
 *  - the multiplier set is {1000, 10000, 1000000} (`./normalize-symbol.ts`).
 */

import type { MarketInterface } from 'ccxt'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { normalizeSymbol } from './normalize-symbol.js'

/** Funding intervals the engine accepts (`00_globals.md` §8.1); anything else is an anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])
/** Bybit's default funding cadence when the market metadata carries none (8 h, majority of USDT perps). */
const DEFAULT_FUNDING_INTERVAL_HOURS = 8
/** `info.fundingInterval` is in minutes on Bybit v5 (`/v5/market/instruments-info`). */
const MINUTES_PER_HOUR = 60

/** A positive, finite number — the shape every load-bearing precision/size field must have. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-negative, finite number, or `undefined` — the shape ccxt exchange minimums take. */
function optionalMin(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Exchange minimum notional, quote currency. ccxt leaves `limits.cost` **empty** on Bybit, so
 * the real value has to come off the raw row (`info.lotSizeFilter.minNotionalValue`, a string,
 * `"5"` on the live listing). Losing it would silently under-check preflight's min-notional
 * gate (`12` §3), so the ccxt slot is preferred when present and this is the fallback.
 */
function readMinNotional(market: MarketInterface): number {
  const fromCcxt = market.limits.cost?.min
  if (typeof fromCcxt === 'number' && Number.isFinite(fromCcxt) && fromCcxt > 0) return fromCcxt
  const info = market.info
  const lot =
    info !== null && typeof info === 'object' ? (info as { lotSizeFilter?: unknown }).lotSizeFilter : undefined
  const raw =
    lot !== null && typeof lot === 'object' ? (lot as { minNotionalValue?: unknown }).minNotionalValue : undefined
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Funding interval (hours) for a Bybit market: `info.fundingInterval` **minutes** → hours,
 * else the 8 h default. Validated against the accepted set by the caller so a
 * non-{1,2,4,8} value aborts (`10` §3 fail-loud) — including the `0` the dated rows carry.
 */
function readFundingIntervalHours(info: unknown): number {
  if (info !== null && typeof info === 'object' && 'fundingInterval' in info) {
    const raw = (info as Record<string, unknown>).fundingInterval
    const minutes = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN
    if (Number.isFinite(minutes)) return minutes / MINUTES_PER_HOUR
  }
  return DEFAULT_FUNDING_INTERVAL_HOURS
}

/**
 * Map one ccxt market to a validated {@link Instrument}, or **throw** on any anomaly
 * (unparsable symbol, missing/zero contract size or precision, out-of-set funding
 * interval). Every throw carries the venue symbol so a bad startup pinpoints it.
 */
export function ccxtMarketToInstrument(market: MarketInterface): Instrument {
  const venueSymbol = market.id
  if (typeof venueSymbol !== 'string' || venueSymbol.length === 0) {
    throw new Error(`Bybit instrument: market has no venue id (symbol '${market.symbol ?? '?'}')`)
  }
  const at = `Bybit instrument '${venueSymbol}'`

  if (typeof market.base !== 'string' || market.base.length === 0) {
    throw new Error(`${at}: unparsable base symbol`)
  }
  const { normalized, multiplier } = normalizeSymbol(market.base)

  if (!isPositiveNumber(market.contractSize)) {
    throw new Error(`${at}: missing or non-positive contractSize (${String(market.contractSize)})`)
  }
  if (!isPositiveNumber(market.precision.price)) {
    throw new Error(`${at}: missing or non-positive price precision (${String(market.precision.price)})`)
  }
  if (!isPositiveNumber(market.precision.amount)) {
    throw new Error(`${at}: missing or non-positive amount precision (${String(market.precision.amount)})`)
  }

  const fundingIntervalHours = readFundingIntervalHours(market.info)
  if (!VALID_FUNDING_INTERVALS.has(fundingIntervalHours)) {
    throw new Error(`${at}: funding interval ${fundingIntervalHours}h ∉ {1,2,4,8}`)
  }

  return {
    normalized,
    venueSymbol,
    // Fold the venue multiplier so all core math is base-unit (`10` §4).
    contractSize: market.contractSize * multiplier,
    pricePrecision: market.precision.price,
    amountPrecision: market.precision.amount,
    minNotional: readMinNotional(market),
    minQty: optionalMin(market.limits.amount?.min),
    fundingIntervalHours,
  }
}

/**
 * The `10` §3 universe filter: keep active linear USDT perpetual swaps, then drop any
 * symbol whose canonical name is in `deny`. `undefined` slots (ccxt returns a dictionary
 * that may carry them) are skipped.
 *
 * The `quote === 'USDT'` test also excludes Bybit's 68 USDC perps (`BTCPERP` &c.), which
 * settle in a different asset than the one the strategy sizes against.
 */
export function filterMarkets(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
): MarketInterface[] {
  const denied = new Set(deny)
  return markets.filter((m): m is MarketInterface => {
    if (!m) return false
    if (m.type !== 'swap' || m.linear !== true || m.quote !== 'USDT' || m.active !== true) return false
    return !denied.has(normalizeSymbol(m.base).normalized)
  })
}

/**
 * Build the validated `normalized → Instrument` registry from raw ccxt markets: filter
 * (`10` §3), map+validate each (fail-loud). Returns a fresh map so the caller can swap it
 * in atomically.
 *
 * Canonical-name collision: same policy as Binance — a venue may list both a plain and a
 * multiplier variant of the same ticker, which both fold to one canonical name. Aborting
 * the venue on that is wrong (it would never start), so the **plain (lowest-multiplier)
 * listing wins**, deterministically regardless of ccxt ordering; the folded duplicate is
 * dropped and logged.
 *
 * `log` — structured-log callback for a dropped collision; no-op when absent.
 */
export function buildInstrumentRegistry(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): Map<string, Instrument> {
  const registry = new Map<string, Instrument>()
  const chosenMultiplier = new Map<string, number>()
  for (const market of filterMarkets(markets, deny)) {
    const instrument = ccxtMarketToInstrument(market)
    const multiplier = normalizeSymbol(market.base).multiplier
    const existing = chosenMultiplier.get(instrument.normalized)
    if (existing !== undefined && multiplier >= existing) {
      log?.('bybit: dropped colliding instrument listing', {
        normalized: instrument.normalized,
        venueSymbol: instrument.venueSymbol,
        keptMultiplier: existing,
        droppedMultiplier: multiplier,
      })
      continue // keep the plainer listing
    }
    chosenMultiplier.set(instrument.normalized, multiplier)
    registry.set(instrument.normalized, instrument)
  }
  return registry
}
