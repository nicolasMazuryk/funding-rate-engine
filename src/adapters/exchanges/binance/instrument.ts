/**
 * ccxt `Market` → validated {@link Instrument} mapping + the `10` §3 filter — pure,
 * no I/O (the ccxt market object is passed in). This is the fail-loud heart of the
 * Binance adapter: a wrong `contractSize` silently mis-sizes every future order
 * (`10` §4), so any anomaly **throws** and aborts startup rather than trading on a
 * bad instrument.
 *
 * Convention (matches the sim's `1000PEPE` row and the 0120 sizing math):
 *  - precisions / min-qty are the venue's own step sizes, taken from ccxt as-is;
 *  - the `1000X` / `1000000X` multiplier is folded into `contractSize` so all core
 *    math stays in base units (`./normalize-symbol.ts`).
 */

import type { MarketInterface } from 'ccxt'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { normalizeSymbol } from './normalize-symbol.js'

/** Funding intervals the engine accepts (`00_globals.md` §8.1); anything else is an anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])
/** Binance's default funding cadence when the market metadata carries none. */
const DEFAULT_FUNDING_INTERVAL_HOURS = 8

/** A positive, finite number — the shape every load-bearing precision/size field must have. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-negative, finite number, or `undefined` — the shape ccxt exchange minimums take. */
function optionalMin(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Funding interval (hours) for a market: read `info.fundingIntervalHours` when the
 * venue exposes it, else Binance's 8h default. Validated against the accepted set by
 * the caller so a non-{1,2,4,8} value aborts (`10` §3 fail-loud).
 */
function readFundingIntervalHours(info: unknown): number {
  if (info !== null && typeof info === 'object' && 'fundingIntervalHours' in info) {
    const raw = (info as Record<string, unknown>).fundingIntervalHours
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN
    if (Number.isFinite(n)) return n
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
    throw new Error(`Binance instrument: market has no venue id (symbol '${market.symbol ?? '?'}')`)
  }
  const at = `Binance instrument '${venueSymbol}'`

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
    minNotional: optionalMin(market.limits.cost?.min),
    minQty: optionalMin(market.limits.amount?.min),
    fundingIntervalHours,
  }
}

/**
 * The `10` §3 universe filter: keep active linear USDT perpetual swaps, then drop
 * any symbol whose canonical name is in `deny`. `undefined` slots (ccxt returns a
 * dictionary that may carry them) are skipped.
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
 * Build the validated `normalized → Instrument` registry from raw ccxt markets:
 * filter (`10` §3), map+validate each (fail-loud). Returns a fresh map so the caller
 * can swap it in atomically.
 *
 * Canonical-name collision: Binance genuinely lists both a plain and a multiplier
 * variant of the same ticker (e.g. `CATUSDT` and `1000CATUSDT`, distinct projects),
 * which both fold to `CAT`. Aborting the venue on that is wrong (it would never
 * start), so the **plain (lowest-multiplier) listing wins**, deterministically
 * regardless of ccxt ordering; the folded duplicate is dropped. This is a known
 * ambiguity flagged for a real disambiguation policy (STATUS/SUGGESTIONS).
 */
export function buildInstrumentRegistry(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
): Map<string, Instrument> {
  const registry = new Map<string, Instrument>()
  const chosenMultiplier = new Map<string, number>()
  for (const market of filterMarkets(markets, deny)) {
    const instrument = ccxtMarketToInstrument(market)
    const multiplier = normalizeSymbol(market.base).multiplier
    const existing = chosenMultiplier.get(instrument.normalized)
    if (existing !== undefined && multiplier >= existing) continue // keep the plainer listing
    chosenMultiplier.set(instrument.normalized, multiplier)
    registry.set(instrument.normalized, instrument)
  }
  return registry
}
