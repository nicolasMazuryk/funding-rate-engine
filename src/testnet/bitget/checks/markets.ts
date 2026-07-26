/**
 * Market load/filter check (`17` §3 bullet 1). Credential-free — the adapter's `init()`
 * already ran in `context.ts` (fail-loud on any bad instrument), so this only asserts the
 * loaded universe is sane and every entry normalizes to a validated `Instrument` with real
 * precision/contract-size metadata.
 *
 * Bitget-specific:
 *  - the funding cadence is a **market-metadata field in hours** (`info.fundInterval`, a
 *    string), so — unlike OKX, which derives it from two timestamps — it loads with the rest
 *    of the metadata and is asserted here;
 *  - **`contractSize` is `1` for every listed symbol** (the multiplier prefixes fold into it,
 *    Binance/Bybit's shape, not OKX's `ctVal`), so a non-unit size on a plain symbol would
 *    mean the multiplier fold mis-fired;
 *  - demo trading serves the **same** `USDT-FUTURES` category as live, just a 24-symbol slice
 *    of it, so the count is only asserted non-zero and reported rather than bounded.
 */

import type { BitgetTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

const SAMPLE_SIZE = 20

/** `00_globals.md` §8.1 — anything else is an instrument anomaly. */
const VALID_FUNDING_INTERVALS = new Set([1, 2, 4, 8])

export const marketsCheck: Check<BitgetTestnetContext> = {
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

    // The venue-defining property (`10` §4): the size on the wire is base units, so a plain
    // symbol must carry contractSize 1 — anything else means the multiplier fold mis-fired.
    const btc = ctx.adapter.normalize('BTC')
    if (btc.contractSize !== 1) {
      throw new Error(`BTC contractSize is ${btc.contractSize}, expected 1 (Bitget sizes in base units)`)
    }
    const instruments = markets.map((m) => ctx.adapter.normalize(m.normalized))
    const intervals = [...new Set(instruments.map((i) => i.fundingIntervalHours))].sort((a, b) => a - b)

    return {
      status: 'pass',
      detail: {
        count: markets.length,
        fundingIntervalsSeen: intervals,
        btcMinNotional: btc.minNotional,
        btcMinQty: btc.minQty,
      },
    }
  },
}
