/**
 * ccxt `Market` → validated {@link Instrument} mapping + the `10` §3 filter for Bitget —
 * pure, no I/O (the ccxt market object is passed in). Mirrors `../okx/instrument.ts`: any
 * anomaly **throws** and aborts startup rather than trading on a bad instrument.
 *
 * Bitget-specific, versus the siblings:
 *  - **the funding interval is one metadata field**, `info.fundInterval`, and its unit is
 *    **hours** as a string (`"8"`, `"4"`). No second REST read (Binance needs `fundingInfo`,
 *    OKX has no field at all and derives the interval from two timestamps), and no unit
 *    conversion (Bybit publishes minutes);
 *  - **`contractSize` is `1` on the whole live linear-USDT listing** (721 markets probed, task
 *    0440), so unlike OKX the face value never leaves the symbol prefix. Bitget publishes **no**
 *    per-instrument face value to cross-check it against — `info.sizeMultiplier` looks like one
 *    but is the *quantity step* (`BTCUSDT` = 0.0001, i.e. ccxt's `precision.amount`), so
 *    comparing the two would reject the venue's most liquid symbol. The invariant enforced
 *    instead is the one that is actually true: the venue contract size **is** 1, and anything
 *    else is fatal (`10` §4) — so a future listing that ships a face value is loud rather than
 *    silently mis-sized;
 *  - **demo trading needs nothing here.** Bitget's `SUSDT-FUTURES` demo product (3 symbols
 *    settled in `SUSDT`) exists only on the **v2 mix** API; the v3/UTA surface this adapter
 *    targets serves demo out of the ordinary `USDT-FUTURES` category with ordinary symbols
 *    (`BTCUSDT`, …), on the same host behind a `PAPTRADING: 1` header — probed live, task 0440.
 *    So the filter is the same `USDT` gate for both environments, and there is no product row
 *    to thread. Demo differs only in *which* symbols are listed (24, not 721).
 */

import type { MarketInterface } from 'ccxt'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { normalizeSymbol } from './normalize-symbol.js'

/** Quote **and** settle asset of the universe (`10` §3) — the same on live and demo trading. */
export const SETTLE_ASSET = 'USDT'
/** Funding intervals the engine accepts (`00_globals.md` §8.1); anything else is an anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])
/** Bitget's majority funding cadence, used when the row carries no usable `fundInterval`. */
const DEFAULT_FUNDING_INTERVAL_HOURS = 8
/** The only contract size Bitget's linear listing publishes; see {@link readContractSize}. */
const VENUE_CONTRACT_SIZE = 1
/** Tolerance on that equality (ccxt parses the raw strings, so exact `=== 1` can drift). */
const CONTRACT_SIZE_EPSILON = 1e-9

/** A positive, finite number — the shape every load-bearing precision/size field must have. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-negative, finite number, or `undefined` — the shape ccxt exchange minimums take. */
function optionalMin(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Read a numeric field off the raw Bitget row (every value there is a string). */
function rawNumber(info: unknown, field: string): number | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const raw = (info as Record<string, unknown>)[field]
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Funding interval (hours) off one Bitget market row: `info.fundInterval`, already in hours.
 * Returns `undefined` when the field is absent, blank or not a positive number, so the caller
 * falls back to the 8 h default and then validates it.
 *
 * `Number('')` is 0 and Bitget writes `""` for "no value", so a blank must never parse as an
 * interval — {@link rawNumber} yields 0 there and the `> 0` gate drops it.
 */
export function readFundingIntervalHours(info: unknown): number | undefined {
  const hours = rawNumber(info, 'fundInterval')
  return hours !== undefined && hours > 0 ? hours : undefined
}

/**
 * Base units per venue contract: ccxt's `contractSize`, which Bitget sets to **1** for every
 * linear listing — the venue sizes orders in base units, not in contracts, so the only face
 * value in play is the one the symbol prefix carries (`../normalize-symbol.ts`).
 *
 * There is nothing on the raw row to cross-check that against. `info.sizeMultiplier` reads like
 * a face value but is the **quantity step** (`BTCUSDT` = `0.0001`, matching ccxt's
 * `precision.amount`), so comparing them — as the OKX sibling compares `ctVal × ctMult` — would
 * throw on the venue's most liquid symbol. The enforceable invariant is the equality itself:
 * anything but 1 means Bitget started publishing contract-denominated sizes, which would
 * mis-size every order, so it is fatal rather than silently trusted (`10` §4).
 */
function readContractSize(market: MarketInterface, at: string): number {
  const fromCcxt = market.contractSize
  if (!isPositiveNumber(fromCcxt)) {
    throw new Error(`${at}: missing or non-positive contractSize (${String(fromCcxt)})`)
  }
  if (Math.abs(fromCcxt - VENUE_CONTRACT_SIZE) > CONTRACT_SIZE_EPSILON) {
    throw new Error(`${at}: contractSize ${fromCcxt} ≠ ${VENUE_CONTRACT_SIZE} — Bitget sizes in base units`)
  }
  return fromCcxt
}

/**
 * Map one ccxt market to a validated {@link Instrument}, or **throw** on any anomaly
 * (unparsable symbol, missing/zero contract size or precision, contract-size disagreement,
 * out-of-set funding interval). Every throw carries the venue symbol so a bad startup
 * pinpoints it.
 */
export function ccxtMarketToInstrument(market: MarketInterface): Instrument {
  const venueSymbol = market.id
  if (typeof venueSymbol !== 'string' || venueSymbol.length === 0) {
    throw new Error(`Bitget instrument: market has no venue id (symbol '${market.symbol ?? '?'}')`)
  }
  const at = `Bitget instrument '${venueSymbol}'`

  if (typeof market.base !== 'string' || market.base.length === 0) {
    throw new Error(`${at}: unparsable base symbol`)
  }
  const { normalized, multiplier } = normalizeSymbol(market.base)

  const contractSize = readContractSize(market, at)
  if (!isPositiveNumber(market.precision.price)) {
    throw new Error(`${at}: missing or non-positive price precision (${String(market.precision.price)})`)
  }
  if (!isPositiveNumber(market.precision.amount)) {
    throw new Error(`${at}: missing or non-positive amount precision (${String(market.precision.amount)})`)
  }

  const fundingIntervalHours = readFundingIntervalHours(market.info) ?? DEFAULT_FUNDING_INTERVAL_HOURS
  if (!VALID_FUNDING_INTERVALS.has(fundingIntervalHours)) {
    throw new Error(`${at}: funding interval ${fundingIntervalHours}h ∉ {1,2,4,8}`)
  }

  return {
    normalized,
    venueSymbol,
    // Fold the venue multiplier so all core math is base-unit (`10` §4): `1000BONKUSDT` sizes
    // in thousands of BONK per contract even though the venue's own `contractSize` is 1.
    contractSize: contractSize * multiplier,
    pricePrecision: market.precision.price,
    amountPrecision: market.precision.amount,
    // `limits.cost.min` is the venue's `minTradeUSDT` (5 on the live listing).
    minNotional: optionalMin(market.limits.cost?.min),
    minQty: optionalMin(market.limits.amount?.min),
    fundingIntervalHours,
  }
}

/**
 * The `10` §3 universe filter: keep active linear USDT-settled perpetual swaps, then drop any
 * symbol whose canonical name is in `deny`. `undefined` slots (ccxt returns a dictionary that
 * may carry them) are skipped.
 *
 * `settle === 'USDT'` drops the venue's inverse (coin-margined) and `USDC`-margined swaps, and
 * holds on **demo trading too** — see the file header: v3/UTA demo lists ordinary `USDT`
 * symbols, not the v2-era `SUSDT` ones.
 */
export function filterMarkets(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
): MarketInterface[] {
  const denied = new Set(deny)
  return markets.filter((m): m is MarketInterface => {
    if (!m) return false
    if (m.type !== 'swap' || m.linear !== true || m.quote !== SETTLE_ASSET || m.settle !== SETTLE_ASSET) return false
    if (m.active !== true) return false
    return !denied.has(normalizeSymbol(m.base).normalized)
  })
}

/**
 * Build the validated `normalized → Instrument` registry from raw ccxt markets: filter
 * (`10` §3), map+validate each (fail-loud). Returns a fresh map so the caller can swap it
 * in atomically.
 *
 * `log` — structured-log callback for a dropped collision; no-op when absent.
 *
 * Canonical-name collision: same policy as the siblings — the **plain (lowest-multiplier)
 * listing wins**, deterministically regardless of ccxt ordering, and the folded duplicate is
 * dropped and logged. Reachable on Bitget (the live listing carries `1000`/`10000`/`1000000`
 * prefixes), which is exactly why the rule is not left implicit.
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
      log?.('bitget: dropped colliding instrument listing', {
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
