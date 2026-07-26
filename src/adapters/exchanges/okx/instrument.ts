/**
 * ccxt `Market` → validated {@link Instrument} mapping + the `10` §3 filter for OKX —
 * pure, no I/O (the ccxt market object is passed in). Mirrors `../bybit/instrument.ts`:
 * any anomaly **throws** and aborts startup rather than trading on a bad instrument.
 *
 * OKX is the venue that makes `contractSize` load-bearing. It sizes in **contracts** with
 * a per-instrument face value `ctVal` (`BTC-USDT-SWAP` = 0.01 BTC, `XRP-USDT-SWAP` = 100
 * XRP): 202 of the 411 live linear USDT swaps have `ctVal ≠ 1`, where Binance and Bybit
 * are 1 for everything but the multiplier listings. `contractSize` is therefore
 * cross-checked against the raw `ctVal × ctMult` and disagreement is fatal.
 *
 * OKX-specific, versus the siblings:
 *  - the funding interval is **not** a metadata field — it is derived from the funding-rate
 *    read (`nextFundingTime − fundingTime`, `./instrument.ts#deriveFundingIntervalHours`)
 *    and passed in as `intervalHoursOverride`, the same shape Binance's `fundingInfo`
 *    override takes. Live cadences are 4 h and 8 h;
 *  - OKX publishes **no per-instrument minimum notional** (ccxt leaves `limits.cost` empty
 *    on all 411 rows and the raw row has no equivalent field), so `minNotional` is 0 and
 *    the min-order gate rests on `minSz` alone;
 *  - `minSz` / `lotSz` are counted in **contracts**, consistent with `computeQty`
 *    (`amountUsd / price / contractSize`), so they are carried through as-is.
 */

import type { MarketInterface } from 'ccxt'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { normalizeSymbol } from './normalize-symbol.js'

/** Funding intervals the engine accepts (`00_globals.md` §8.1); anything else is an anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])
/** OKX's majority funding cadence, used when no interval could be derived for a symbol. */
const DEFAULT_FUNDING_INTERVAL_HOURS = 8
const MS_PER_HOUR = 3_600_000
/** Relative tolerance for the `ctVal × ctMult` vs ccxt `contractSize` cross-check (float parse drift). */
const CONTRACT_SIZE_EPSILON = 1e-9

/** A positive, finite number — the shape every load-bearing precision/size field must have. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A non-negative, finite number, or `undefined` — the shape ccxt exchange minimums take. */
function optionalMin(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** An epoch-ms timestamp off the wire, where OKX writes `""` for "no value". */
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read a numeric field off the raw OKX row (every value there is a string). */
function rawNumber(info: unknown, field: string): number | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const raw = (info as Record<string, unknown>)[field]
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Funding interval (hours) from one OKX funding-rate row: `(nextFundingTime −
 * fundingTime) / 1h`. OKX ships no interval field — this subtraction *is* the interval
 * (Binance publishes hours, Bybit minutes). Returns `undefined` when either timestamp is
 * missing or the difference is not positive, so the caller falls back and then validates.
 */
export function deriveFundingIntervalHours(fundingTimeMs: unknown, nextFundingTimeMs: unknown): number | undefined {
  // `Number('')` is 0, and OKX writes `""` for every field it has no value for — so an empty
  // string must never parse as an epoch, or a blank pair would derive a bogus interval.
  const from = timestamp(fundingTimeMs)
  const to = timestamp(nextFundingTimeMs)
  if (from === undefined || to === undefined) return undefined
  const hours = (to - from) / MS_PER_HOUR
  return hours > 0 ? hours : undefined
}

/**
 * Base units per contract: ccxt's `contractSize`, cross-checked against the venue's own
 * `ctVal × ctMult`. They agree on the whole live listing; if they ever do not, the mapping
 * is wrong in a way that mis-sizes every order for that symbol, so it throws (`10` §4).
 */
function readContractSize(market: MarketInterface, at: string): number {
  const fromCcxt = market.contractSize
  if (!isPositiveNumber(fromCcxt)) {
    throw new Error(`${at}: missing or non-positive contractSize (${String(fromCcxt)})`)
  }
  const ctVal = rawNumber(market.info, 'ctVal')
  if (ctVal === undefined) return fromCcxt
  const ctMult = rawNumber(market.info, 'ctMult') ?? 1
  const fromVenue = ctVal * ctMult
  if (Math.abs(fromVenue - fromCcxt) > CONTRACT_SIZE_EPSILON * Math.max(1, fromCcxt)) {
    throw new Error(`${at}: contractSize ${fromCcxt} disagrees with ctVal×ctMult ${fromVenue}`)
  }
  return fromVenue
}

/**
 * Map one ccxt market to a validated {@link Instrument}, or **throw** on any anomaly
 * (unparsable symbol, missing/zero contract size or precision, contract-size disagreement,
 * out-of-set funding interval). Every throw carries the venue symbol so a bad startup
 * pinpoints it.
 *
 * `intervalHoursOverride` — the per-symbol interval derived from
 * `GET /api/v5/public/funding-rate` ({@link deriveFundingIntervalHours}); absent, the 8 h
 * default applies and is validated the same way.
 */
export function ccxtMarketToInstrument(market: MarketInterface, intervalHoursOverride?: number): Instrument {
  const venueSymbol = market.id
  if (typeof venueSymbol !== 'string' || venueSymbol.length === 0) {
    throw new Error(`OKX instrument: market has no venue id (symbol '${market.symbol ?? '?'}')`)
  }
  const at = `OKX instrument '${venueSymbol}'`

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

  const fundingIntervalHours = intervalHoursOverride ?? DEFAULT_FUNDING_INTERVAL_HOURS
  if (!VALID_FUNDING_INTERVALS.has(fundingIntervalHours)) {
    throw new Error(`${at}: funding interval ${fundingIntervalHours}h ∉ {1,2,4,8}`)
  }

  return {
    normalized,
    venueSymbol,
    // Fold the venue multiplier so all core math is base-unit (`10` §4). OKX carries the
    // face value in `ctVal`, so the multiplier is 1 on every current listing.
    contractSize: contractSize * multiplier,
    pricePrecision: market.precision.price,
    amountPrecision: market.precision.amount,
    // OKX publishes no per-instrument minimum notional — see the file header.
    minNotional: optionalMin(market.limits.cost?.min),
    minQty: optionalMin(market.limits.amount?.min),
    fundingIntervalHours,
  }
}

/**
 * The `10` §3 universe filter: keep active linear USDT-settled perpetual swaps, then drop
 * any symbol whose canonical name is in `deny`. `undefined` slots (ccxt returns a
 * dictionary that may carry them) are skipped.
 *
 * `settle === 'USDT'` is the OKX-shaped half of the test: the venue's inverse swaps
 * (`BTC-USD-SWAP`) and its dated futures (`BTC-USD-260731`) settle in the coin, and its
 * `USDC`-margined swaps settle in an asset the strategy does not size against.
 */
export function filterMarkets(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
): MarketInterface[] {
  const denied = new Set(deny)
  return markets.filter((m): m is MarketInterface => {
    if (!m) return false
    if (m.type !== 'swap' || m.linear !== true || m.quote !== 'USDT' || m.settle !== 'USDT') return false
    if (m.active !== true) return false
    return !denied.has(normalizeSymbol(m.base).normalized)
  })
}

/**
 * Build the validated `normalized → Instrument` registry from raw ccxt markets: filter
 * (`10` §3), map+validate each (fail-loud). Returns a fresh map so the caller can swap it
 * in atomically.
 *
 * `intervalHoursByVenueSymbol` — funding intervals derived from the funding-rate read,
 * keyed by `instId`; absent entries fall back to the 8 h default per market.
 * `log` — structured-log callback for a dropped collision; no-op when absent.
 *
 * Canonical-name collision: same policy as the siblings — the **plain (lowest-multiplier)
 * listing wins**, deterministically regardless of ccxt ordering, and the folded duplicate
 * is dropped and logged. Unreachable on today's OKX listing (no multiplier prefixes), kept
 * so the three venues behave identically if one ever appears.
 */
export function buildInstrumentRegistry(
  markets: readonly (MarketInterface | undefined)[],
  deny: readonly string[] = [],
  intervalHoursByVenueSymbol?: ReadonlyMap<string, number>,
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): Map<string, Instrument> {
  const registry = new Map<string, Instrument>()
  const chosenMultiplier = new Map<string, number>()
  for (const market of filterMarkets(markets, deny)) {
    const instrument = ccxtMarketToInstrument(
      market,
      market.id !== undefined ? intervalHoursByVenueSymbol?.get(market.id) : undefined,
    )
    const multiplier = normalizeSymbol(market.base).multiplier
    const existing = chosenMultiplier.get(instrument.normalized)
    if (existing !== undefined && multiplier >= existing) {
      log?.('okx: dropped colliding instrument listing', {
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
