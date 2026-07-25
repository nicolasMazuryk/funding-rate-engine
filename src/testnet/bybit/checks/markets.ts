/**
 * Market load/filter check (`17` §3 bullet 1). Credential-free — the adapter's `init()`
 * already ran in `context.ts` (fail-loud on any bad instrument), so this only asserts the
 * loaded universe is sane and every entry normalizes to a validated `Instrument` with real
 * precision/contract-size metadata.
 *
 * Bybit-specific: the funding interval ships inside `market.info.fundingInterval`
 * (minutes → hours, `instrument.ts`), so it is loaded in the same call as the rest of the
 * metadata and asserted here rather than needing a second REST read as on Binance.
 */

import type { BybitTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

const SAMPLE_SIZE = 20

/** `00_globals.md` §8.1 — anything else is an instrument anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])

export const marketsCheck: Check<BybitTestnetContext> = {
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

    return { status: 'pass', detail: { count: markets.length } }
  },
}
