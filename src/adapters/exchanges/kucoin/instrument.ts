/**
 * ccxt `Market` → validated {@link Instrument} mapping + the `10` §3 filter for KuCoin Futures —
 * pure, no I/O (the ccxt market object is passed in). Mirrors `../okx/instrument.ts`: any
 * anomaly **throws** and aborts startup rather than trading on a bad instrument.
 *
 * KuCoin-specific, versus the siblings:
 *
 *  - **the face value lives in `info.multiplier`**, like OKX's `ctVal` and unlike Bitget's
 *    flat `1`. ccxt copies it into `contractSize` verbatim (`XBTUSDTM` → 0.001 BTC,
 *    `DOGEUSDTM` → 100 DOGE), and the two are cross-checked here — disagreement is fatal,
 *    because a wrong contract size silently mis-sizes every order (`10` §4). Sizes on the wire
 *    are **integer contract counts** (`precision.amount === 1`, `lotSize: 1`), which is already
 *    `computeQty`'s unit (`amountUsd / price / contractSize`).
 *
 *  - **the name-prefix multiplier is NOT folded** — the one real deviation from the three
 *    siblings, and the reason `contract-size-chain.test.ts` exists. On a prefixed KuCoin
 *    listing the prefix is already inside *both* numbers the sizing math uses: the quoted
 *    price is per prefixed unit (probed live: `1000BONK/USDT:USDT` last ≈ 1000 × spot BONK)
 *    and `multiplier` counts prefixed units per contract. Folding it a second time — as
 *    `../bybit/instrument.ts` does — would divide `computeQty` by the prefix again and
 *    under-size every order on that symbol by 1000×. So `normalizeSymbol` is used for the
 *    canonical **name** only; see `./normalize-symbol.ts`, and the SUGGESTIONS entry that
 *    carries the same question back to the sibling venues.
 *
 *  - **the funding interval is a millisecond field**, `info.fundingRateGranularity`
 *    (3 600 000 / 14 400 000 / 28 800 000 on the live listing = 1 h / 4 h / 8 h). Binance
 *    publishes hours, Bybit minutes, Bitget hours-as-a-string, OKX nothing at all; KuCoin is
 *    the only one in ms, and the only one whose sole `null` row is a dated inverse future the
 *    filter drops anyway.
 *
 *  - **the inverse family is filtered by `settle`, as always**, but it is unusually visible
 *    here: `XBTUSDM`/`ETHUSDM`/`XBTMU26` are coin-margined siblings of the linear symbols and
 *    carry `info.multiplier: -1`, which would fail the positive-contract-size guard if it ever
 *    reached it. `settle === 'USDT'` drops them first.
 */

import type { MarketInterface } from 'ccxt'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { normalizeSymbol } from './normalize-symbol.js'

/** Quote **and** settle asset of the universe (`10` §3). */
export const SETTLE_ASSET = 'USDT'
/** Funding intervals the engine accepts (`00_globals.md` §8.1); anything else is an anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])
/** KuCoin's majority funding cadence, used when the row carries no usable granularity. */
const DEFAULT_FUNDING_INTERVAL_HOURS = 8
const MS_PER_HOUR = 3_600_000
/** Relative tolerance for the `info.multiplier` vs ccxt `contractSize` cross-check (parse drift). */
const CONTRACT_SIZE_EPSILON = 1e-9

/** A positive, finite number — the shape every load-bearing precision/size field must have. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-negative, finite number, or `undefined` — the shape ccxt exchange minimums take. */
function optionalMin(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Read a numeric field off the raw KuCoin row (numbers arrive as numbers here, strings elsewhere). */
function rawNumber(info: unknown, field: string): number | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const raw = (info as Record<string, unknown>)[field]
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Funding interval (hours) off one KuCoin market row: `info.fundingRateGranularity`, in
 * **milliseconds**. Returns `undefined` when the field is absent or not a positive number, so
 * the caller falls back to the 8 h default and then validates it.
 */
export function readFundingIntervalHours(info: unknown): number | undefined {
  const ms = rawNumber(info, 'fundingRateGranularity')
  if (ms === undefined || ms <= 0) return undefined
  return ms / MS_PER_HOUR
}

/**
 * Units of the ccxt `base` per venue contract: ccxt's `contractSize`, cross-checked against the
 * venue's own `info.multiplier`. They agree across the whole live linear listing; if they ever
 * do not, the mapping is wrong in a way that mis-sizes every order for that symbol, so it
 * throws (`10` §4).
 *
 * "Units of the ccxt `base`" is load-bearing on a prefixed listing: for `1000BONKUSDTM` the base
 * *is* `1000BONK`, so 1000 here means 1000 × 1000BONK — and the quoted price is per 1000BONK to
 * match. See the file header for why the prefix is therefore never folded on top.
 */
function readContractSize(market: MarketInterface, at: string): number {
  const fromCcxt = market.contractSize
  if (!isPositiveNumber(fromCcxt)) {
    throw new Error(`${at}: missing or non-positive contractSize (${String(fromCcxt)})`)
  }
  const multiplier = rawNumber(market.info, 'multiplier')
  if (multiplier === undefined) return fromCcxt
  if (Math.abs(multiplier - fromCcxt) > CONTRACT_SIZE_EPSILON * Math.max(1, fromCcxt)) {
    throw new Error(`${at}: contractSize ${fromCcxt} disagrees with info.multiplier ${multiplier}`)
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
    throw new Error(`KuCoin instrument: market has no venue id (symbol '${market.symbol ?? '?'}')`)
  }
  const at = `KuCoin instrument '${venueSymbol}'`

  if (typeof market.base !== 'string' || market.base.length === 0) {
    throw new Error(`${at}: unparsable base symbol`)
  }
  // Name only — the multiplier is deliberately not folded into `contractSize` here (file header).
  const { normalized } = normalizeSymbol(market.base)

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
    contractSize,
    pricePrecision: market.precision.price,
    amountPrecision: market.precision.amount,
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
 * `settle === 'USDT'` drops both non-linear families KuCoin lists: the coin-margined perpetuals
 * (`XBTUSDM`, `ETHUSDM`, …) and the dated inverse future (`XBTMU26`, `type: 'future'`), plus the
 * seven `USDC`-settled swaps the strategy does not size against.
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
 * (`10` §3), map+validate each (fail-loud). Returns a fresh map so the caller can swap it in
 * atomically.
 *
 * `log` — structured-log callback for a dropped collision; no-op when absent.
 *
 * Canonical-name collision: same policy as the siblings — the **plain (lowest-multiplier)
 * listing wins**, deterministically regardless of ccxt ordering, and the prefixed duplicate is
 * dropped and logged. This is the only place the prefix multiplier is read on KuCoin.
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
      log?.('kucoin: dropped colliding instrument listing', {
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
