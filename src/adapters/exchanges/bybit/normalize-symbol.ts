/**
 * Venue-symbol → canonical-name normalization for Bybit (`10` §4 denomination).
 *
 * Same split as the Binance sibling (`../binance/normalize-symbol.ts`): the canonical
 * name plus the multiplier the caller folds into `Instrument.contractSize`, so all core
 * math stays in base units and the multiplier only exists at the API boundary.
 *
 * Bybit quirk: the live `linear` listing uses **three** multiplier prefixes — `1000`,
 * `10000` and `1000000` (Binance only ever uses `1000`/`1000000`), e.g. `1000PEPEUSDT`,
 * `10000WHYUSDT`, `1000000MOGUSDT`. The listing also contains genuine names that merely
 * *start* with those digits (`1INCH`, `2Z`, `0G`), so a prefix only counts when a letter
 * follows it — otherwise `1INCH` would silently normalize to `NCH` (wrong instrument).
 *
 * Pure — no I/O; unit-tested in isolation.
 */

/** The multipliers Bybit uses as a symbol prefix, longest first (match order matters). */
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
 * the canonical name and the multiplier. A prefix only counts when a letter follows it,
 * so genuine names that merely start with those digits (`1INCH`, `2Z`, `0G`) are left
 * intact. Longest prefix first, so `1000000MOG` folds 1e6 rather than 1000 + `000MOG`.
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
