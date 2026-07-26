/**
 * Market load/filter check (`17` §3 bullet 1). Credential-free — the adapter's `init()`
 * already ran in `context.ts` (fail-loud on any bad instrument), so this only asserts the
 * loaded universe is sane and every entry normalizes to a validated `Instrument` with real
 * precision/contract-size metadata.
 *
 * Two OKX-specific assertions the sibling venues cannot make:
 *  - **`contractSize ≠ 1` is the normal case.** OKX sizes in contracts with a per-instrument
 *    face value (`ctVal`), so the live universe must contain non-unit contract sizes. If it
 *    ever came back all-1s, the `ctVal` read silently degraded to ccxt's default and every
 *    order would be mis-sized — the exact failure this venue was chosen to stress (DoD 1).
 *  - **the funding interval is derived, not published.** It comes from
 *    `nextFundingTime − fundingTime` off a second REST read (`instrument.ts`), so a live run
 *    is the only place the derivation is proven against the real cadences (4 h and 8 h).
 */

import type { OkxTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

const SAMPLE_SIZE = 20

/** `00_globals.md` §8.1 — anything else is an instrument anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])

export const marketsCheck: Check<OkxTestnetContext> = {
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

    // The venue-defining property: contract face values are per instrument, not all 1.
    const instruments = markets.map((m) => ctx.adapter.normalize(m.normalized))
    const nonUnit = instruments.filter((i) => i.contractSize !== 1)
    if (nonUnit.length === 0) {
      throw new Error('every OKX instrument reports contractSize 1 — ctVal did not reach the registry')
    }
    const intervals = [...new Set(instruments.map((i) => i.fundingIntervalHours))].sort((a, b) => a - b)

    return {
      status: 'pass',
      detail: {
        count: markets.length,
        nonUnitContractSize: nonUnit.length,
        fundingIntervalsSeen: intervals,
        btcContractSize: ctx.adapter.normalize('BTC').contractSize,
      },
    }
  },
}
