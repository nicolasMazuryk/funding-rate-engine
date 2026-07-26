/**
 * Venue-symbol → canonical-name normalization for KuCoin Futures (`10` §4 denomination).
 *
 * Same signature as the three siblings (`../bybit/normalize-symbol.ts` et al) — canonical name
 * plus the multiplier carried by a name prefix — but KuCoin is the venue where the **caller
 * must not fold that multiplier into `contractSize`**. See `./instrument.ts`: on this venue the
 * face value already lives in the per-symbol `multiplier` field, *and* the quoted price is per
 * prefixed unit, so folding the prefix a second time under-sizes every order by exactly it.
 * The value is still returned because the registry's canonical-name collision policy (plain
 * listing wins) is expressed in terms of it, exactly as on the siblings.
 *
 * Two KuCoin naming facts, both settled against the live listing (task 0460):
 *  - **`XBT` is not our problem.** KuCoin spells Bitcoin `XBT` on the wire (`XBTUSDTM`), but
 *    ccxt already maps that to `base: 'BTC'` — so there is no alias table here, and
 *    `normalize-symbol.test.ts` pins *where* the mapping happens so a ccxt upgrade that drops
 *    it fails in the test rather than in production.
 *  - the same three prefixes as Bybit/Bitget appear (`1000BONK`, `10000CAT`, `1000000MOG`),
 *    alongside the same letter-follows traps (`1INCH`, `2Z`, `0G`, `4`) and one that is not a
 *    numeric prefix at all (`1MBABYDOGE` — `1M` is not in the set, so it stays intact).
 *
 * Pure — no I/O; unit-tested in isolation.
 */

/** The multipliers KuCoin uses as a symbol prefix, longest first (match order matters). */
const MULTIPLIERS = [1_000_000, 10_000, 1_000] as const

/** A ccxt base split into its canonical name and the multiplier prefix stripped from it. */
export interface NormalizedSymbol {
  /** Canonical internal name, e.g. `1000BONK` → `BONK`. */
  readonly normalized: string
  /**
   * The multiplier the **name prefix** carries; `1` when there is none. Used only for the
   * collision policy — deliberately **not** folded into `contractSize` on this venue
   * (`./instrument.ts`).
   */
  readonly multiplier: number
}

/**
 * Strip a leading `1000` / `10000` / `1000000` multiplier from a ccxt `base`, returning the
 * canonical name and that multiplier. A prefix only counts when a letter follows it, so genuine
 * names that merely start with those digits (`1INCH`, `2Z`, `0G`) are left intact. Longest
 * prefix first, so `1000000MOG` folds 1e6 rather than 1000 + `000MOG`.
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
