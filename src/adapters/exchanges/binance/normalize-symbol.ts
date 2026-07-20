/**
 * Venue-symbol → canonical-name normalization (`10` §4 denomination).
 *
 * Binance lists high-supply, low-price assets under a `1000X` / `1000000X`
 * multiplier (e.g. `1000PEPE`, `1000000MOG`) where one venue contract is that
 * many base units. Internally the engine trades the *base* name (`PEPE`) and
 * folds the multiplier into `Instrument.contractSize`, so all core math stays in
 * base units and the multiplier only exists at the API boundary. This pure helper
 * is that split: the canonical name plus the multiplier the caller folds.
 *
 * Pure — no I/O; unit-tested in isolation.
 */

/** The multipliers Binance uses as a symbol prefix, longest first (match order matters). */
const MULTIPLIERS = [1_000_000, 1_000] as const

/** A ccxt base split into its canonical name and the venue multiplier stripped from it. */
export interface NormalizedSymbol {
  /** Canonical internal name, e.g. `1000PEPE` → `PEPE`. */
  readonly normalized: string
  /** Base units per venue contract carried by the prefix; `1` when there is none. */
  readonly multiplier: number
}

/**
 * Strip a leading `1000` / `1000000` multiplier from a ccxt `base`, returning the
 * canonical name and the multiplier. A prefix only counts when a letter follows it,
 * so genuine names that merely start with those digits (`1INCH`) are left intact.
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
