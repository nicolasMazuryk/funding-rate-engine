/**
 * Venue-symbol → canonical-name normalization for OKX (`10` §4 denomination).
 *
 * Same split as the Binance/Bybit siblings: the canonical name plus the multiplier the
 * caller folds into `Instrument.contractSize`, so all core math stays in base units and
 * the multiplier only exists at the API boundary.
 *
 * OKX quirk: the venue carries the contract face value in `ctVal` (`BTC-USDT-SWAP` is
 * 0.01 BTC/contract) instead of encoding it as a `1000X` name prefix, so on the live
 * listing **every** base normalizes with `multiplier: 1` — the prefix strip below is a
 * forward guard, kept identical to the siblings so one venue's listing change does not
 * become a silent mis-size. The `1INCH` / `2Z` / `0G` names OKX genuinely lists are the
 * reason a prefix only counts when a letter follows it (otherwise `1INCH` → `NCH`, the
 * wrong instrument).
 *
 * Pure — no I/O; unit-tested in isolation.
 */

/** Multiplier prefixes recognised across venues, longest first (match order matters). */
const MULTIPLIERS = [1_000_000, 10_000, 1_000] as const

/** A ccxt base split into its canonical name and the venue multiplier stripped from it. */
export interface NormalizedSymbol {
  /** Canonical internal name, e.g. `1000PEPE` → `PEPE`. */
  readonly normalized: string
  /** Base units per venue contract carried by the prefix; `1` when there is none. */
  readonly multiplier: number
}

/**
 * Strip a leading `1000` / `10000` / `1000000` multiplier from a ccxt `base`, returning
 * the canonical name and the multiplier. A prefix only counts when a letter follows, so
 * genuine OKX names that merely start with digits (`1INCH`, `2Z`, `0G`) are left intact.
 */
export function normalizeSymbol(base: string): NormalizedSymbol {
  for (const multiplier of MULTIPLIERS) {
    const prefix = String(multiplier)
    const rest = base.slice(prefix.length)
    if (base.startsWith(prefix) && /^[A-Za-z]/.test(rest)) {
      return { normalized: rest, multiplier }
    }
  }
  return { normalized: base, multiplier: 1 }
}

/**
 * Canonical name from an OKX `instId` (`BTC-USDT-SWAP` → `BTC`), for the paths that hold a
 * venue symbol but no ccxt market — the WS channels and the funding-interval read both key
 * on `instId`. Returns `undefined` when the id is not a three-part swap id, so a caller
 * can fail loud rather than invent a symbol.
 */
export function instIdToNormalized(instId: string): string | undefined {
  const parts = instId.split('-')
  if (parts.length !== 3 || parts[2] !== 'SWAP') return undefined
  const base = parts[0]
  return base === undefined || base.length === 0 ? undefined : normalizeSymbol(base).normalized
}
