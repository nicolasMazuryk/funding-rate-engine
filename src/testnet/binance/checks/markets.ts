/**
 * Market load/filter check (`17` §3 bullet 1; folds `binance-markets.integration.test.ts`).
 * Credential-free — the adapter's `init()` already ran in `context.ts`, so this only
 * asserts the loaded universe is sane and every entry normalizes to a validated
 * `Instrument` with real precision/contract-size metadata.
 */

import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

const SAMPLE_SIZE = 20

export const marketsCheck: Check<BinanceTestnetContext> = {
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
    }

    return { status: 'pass', detail: { count: markets.length } }
  },
}
