/**
 * Market load/filter check (`17` §3 bullet 1). Credential-free and read-only — the adapter's
 * `init()` already ran in `context.ts` (fail-loud on any bad instrument), so this only asserts
 * the loaded universe is sane and every entry normalizes to a validated `Instrument` with real
 * precision/contract-size metadata.
 *
 * KuCoin-specific:
 *  - **`contractSize` is per instrument** (`info.multiplier`: `XBTUSDTM` = 0.001 BTC,
 *    `DOGEUSDTM` = 100 DOGE) — OKX's shape, the mirror image of Bitget's flat `1`. A universe
 *    where *every* size is `1` would mean the multiplier read silently fell back, so the
 *    presence of a non-unit size is asserted rather than assumed.
 *  - **the name-prefix multiplier is deliberately not folded** into `contractSize`
 *    (`../../../adapters/exchanges/kucoin/instrument.ts` explains why: the quoted price is
 *    already per prefixed unit). The canonical *name* is still stripped, so this asserts the
 *    naming half — no canonical name may keep a `1000`/`10000`/`1000000` prefix.
 *  - **the funding interval is a millisecond field** (`info.fundingRateGranularity`), the only
 *    venue of the five in ms; live cadences are 1 h / 4 h / 8 h.
 */

import type { KucoinLiveContext } from '../../context.js'
import type { Check } from '../../types.js'

const SAMPLE_SIZE = 20

/** `00_globals.md` §8.1 — anything else is an instrument anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])

/** The venue's multiplier prefixes (`./normalize-symbol.ts`), longest first. */
const PREFIXES = ['1000000', '10000', '1000'] as const

/** True when a canonical name still carries an unstripped multiplier prefix (`1000BONK`). */
function hasUnstrippedPrefix(normalized: string): boolean {
  return PREFIXES.some((p) => normalized.startsWith(p) && /^[A-Za-z]/.test(normalized.slice(p.length)))
}

export const marketsCheck: Check<KucoinLiveContext> = {
  name: 'markets',
  specRef: '17 §3 market load/filter',
  async run(ctx) {
    const markets = ctx.adapter.markets()
    if (markets.length === 0) throw new Error('adapter loaded zero markets')

    for (const m of markets.slice(0, SAMPLE_SIZE)) {
      const inst = ctx.adapter.normalize(m.normalized)
      if (!(inst.contractSize > 0)) throw new Error(`${m.normalized}: non-positive contractSize`)
      if (!(inst.pricePrecision > 0)) throw new Error(`${m.normalized}: non-positive pricePrecision`)
      if (!(inst.amountPrecision > 0)) throw new Error(`${m.normalized}: non-positive amountPrecision`)
      if (!(inst.minNotional >= 0)) throw new Error(`${m.normalized}: negative minNotional`)
      if (!VALID_FUNDING_INTERVALS.has(inst.fundingIntervalHours)) {
        throw new Error(`${m.normalized}: funding interval ${inst.fundingIntervalHours}h outside {1,2,4,8}`)
      }
    }

    const instruments = markets.map((m) => ctx.adapter.normalize(m.normalized))

    // Canonical names must be prefix-free even though the *size* keeps the prefix folded in.
    const unstripped = instruments.filter((i) => hasUnstrippedPrefix(i.normalized)).map((i) => i.normalized)
    if (unstripped.length > 0) {
      throw new Error(`canonical names kept a multiplier prefix: ${unstripped.join(', ')}`)
    }

    // The venue-defining property (`10` §4): the face value is per instrument, so BTC must carry
    // its own `multiplier`-derived size and the universe must not be uniformly 1.
    const btc = ctx.adapter.normalize('BTC')
    if (btc.venueSymbol !== 'XBTUSDTM') {
      throw new Error(`BTC maps to venue symbol '${btc.venueSymbol}', expected 'XBTUSDTM' (ccxt's XBT→BTC mapping)`)
    }
    if (btc.contractSize === 1) {
      throw new Error("BTC contractSize is 1 — expected KuCoin's per-instrument face value (info.multiplier)")
    }
    if (instruments.every((i) => i.contractSize === 1)) {
      throw new Error('every instrument has contractSize 1 — the info.multiplier read silently fell back')
    }

    const intervals = [...new Set(instruments.map((i) => i.fundingIntervalHours))].sort((a, b) => a - b)

    return {
      status: 'pass',
      detail: {
        count: markets.length,
        fundingIntervalsSeen: intervals,
        btcContractSize: btc.contractSize,
        btcMinNotional: btc.minNotional,
        btcMinQty: btc.minQty,
      },
    }
  },
}
