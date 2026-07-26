/**
 * Unit: the **contract-size chain** on KuCoin — the venue where the `10` §4 denomination trap
 * actually fires, and the reason `../okx/contract-size-chain.test.ts` has a sibling here rather
 * than being reused.
 *
 * The chain, walked end to end on real captured fixtures:
 *
 *   `<market>.json` → `ccxtMarketToInstrument` → `computeQty` → the `size` `./ws-orders.ts`
 *   puts on the wire → `fromVenueUnits` back to base units.
 *
 * What KuCoin adds over the OKX version:
 *
 *  - **`size` is an integer**. KuCoin's `precision.amount` is `1` and its `lotSize` is `1` on the
 *    whole linear listing, so a contract count is a whole number — where OKX's `lotSz` is `0.01`
 *    and a fractional `sz` is legitimate. A non-integer `size` here means something divided when
 *    it should not have.
 *  - **the prefixed listing.** `1000BONKUSDTM` is the one row where this venue *deviates* from its
 *    three siblings: `contractSize` is the venue `multiplier` (1000) and the name prefix is
 *    deliberately **not** folded on top, because the quoted price is already per prefixed unit
 *    (`src/adapters/exchanges/kucoin/instrument.ts` header). A folded `1000 × 1000 = 1e6` would
 *    divide `computeQty` by the prefix a second time and under-size every order on that symbol
 *    by exactly 1000×. That claim is encoded below as an assertion, not a comment.
 *
 * `toVenueUnits` (`src/core/sizing/denomination.ts`) is **not** in this chain and must not be:
 * `computeQty` is `amountUsd / price / contractSize`, so its output is already the contract count
 * `size`, `minQty` and `amountPrecision` are all in. `fromVenueUnits` is the direction that *is*
 * well defined — contracts → base units — which is what makes the notional assertion meaningful.
 */

import { describe, expect, it } from 'vitest'
import { ccxtMarketToInstrument } from '../../../../../src/adapters/exchanges/kucoin/instrument.js'
import { toOrderParams } from '../../../../../src/adapters/exchanges/kucoin/ws-orders.js'
import type { Instrument } from '../../../../../src/core/ports/exchange-adapter.js'
import { fromVenueUnits } from '../../../../../src/core/sizing/denomination.js'
import { checkFeasibility, computeQty, minFeasibleQty } from '../../../../../src/core/sizing/sizing.js'
import { loadMarket } from './fixtures.js'

/** The `size` the venue actually receives, read off the real payload builder (not a re-derivation). */
function venueSize(qty: number, instrument: Instrument): number {
  return toOrderParams(
    { symbol: instrument.normalized, side: 'long', type: 'market', qty, clientOrderId: 'BTC-1-entry-1' },
    instrument.venueSymbol,
  ).size
}

describe('contract-size chain — KuCoin sizes in integer contracts', () => {
  const btc = ccxtMarketToInstrument(loadMarket('clean-perp-btc'))
  const doge = ccxtMarketToInstrument(loadMarket('multiplier-100-doge'))
  const eth = ccxtMarketToInstrument(loadMarket('multiplier-sub-unit-eth'))

  it('carries the venue face value (info.multiplier) onto the Instrument', () => {
    expect(btc.contractSize).toBe(0.001) // 1 XBTUSDTM = 0.001 BTC
    expect(doge.contractSize).toBe(100) // 1 DOGEUSDTM = 100 DOGE
    expect(eth.contractSize).toBe(0.01) // 1 ETHUSDTM = 0.01 ETH
  })

  it('the lot step is one whole contract on every captured row', () => {
    for (const inst of [btc, doge, eth]) expect(inst.amountPrecision).toBe(1)
  })

  it('sends the contract count, never the base-unit amount ($1000 of BTC at $100k)', () => {
    const qty = computeQty(1_000, 100_000, btc)
    expect(qty).toBe(10) // 10 contracts × 0.001 BTC = 0.01 BTC
    expect(venueSize(qty, btc)).toBe(10)
    // 0.01 is the base-unit amount; sending it would be a 1000× under-size.
    expect(venueSize(qty, btc)).not.toBe(0.01)
    expect(Number.isInteger(venueSize(qty, btc))).toBe(true)
  })

  it('the same, the other way round: a face value above 1 ($1000 of DOGE at $0.10)', () => {
    const qty = computeQty(1_000, 0.1, doge)
    expect(qty).toBe(100) // 100 contracts × 100 DOGE = 10 000 DOGE
    expect(venueSize(qty, doge)).toBe(100)
    // 10 000 is the base-unit amount; sending it would be a 100× over-size.
    expect(venueSize(qty, doge)).not.toBe(10_000)
    expect(Number.isInteger(venueSize(qty, doge))).toBe(true)
  })

  it('the contracts sent are worth the notional asked for (contracts × multiplier × price)', () => {
    expect(fromVenueUnits(computeQty(1_000, 100_000, btc), btc) * 100_000).toBeCloseTo(1_000, 8)
    expect(fromVenueUnits(computeQty(1_000, 0.1, doge), doge) * 0.1).toBeCloseTo(1_000, 8)
    expect(fromVenueUnits(computeQty(2_000, 2_000, eth), eth) * 2_000).toBeCloseTo(2_000, 8)
  })

  it('floors to a whole contract, so a partial contract is never sent', () => {
    // $1050 at $100k = 10.5 contracts; the lot step is 1, so it floors to 10 rather than rounding
    // up into an over-size.
    const qty = computeQty(1_050, 100_000, btc)
    expect(qty).toBe(10)
    expect(Number.isInteger(venueSize(qty, btc))).toBe(true)
  })

  it('feasibility reads the same units — minQty is a contract count', () => {
    expect(btc.minQty).toBe(1) // one contract, not one BTC
    expect(checkFeasibility(computeQty(100, 100_000, btc), 100_000, btc)).toEqual({ ok: true })
    // Below one contract ($100 of BTC = 0.001 contracts) the order is skipped, never coerced up.
    expect(checkFeasibility(computeQty(50, 100_000, btc), 100_000, btc).ok).toBe(false)
  })

  it('minFeasibleQty is a contract count too (S6 pre-funding leg sizing)', () => {
    // KuCoin publishes no per-instrument min notional (`limits.cost` is empty on every row).
    expect(btc.minNotional).toBe(0)
    expect(minFeasibleQty(100_000, btc)).toBe(btc.minQty)
  })
})

describe('contract-size chain — the prefixed listing (1000BONKUSDTM), where KuCoin deviates', () => {
  const bonk = ccxtMarketToInstrument(loadMarket('prefix-1000-bonk'))
  const row = loadMarket('prefix-1000-bonk')

  it('takes contractSize from the venue multiplier and does NOT fold the name prefix on top', () => {
    // The ccxt base *is* `1000BONK`, so `multiplier: 1000` already means 1000 × 1000BONK.
    expect(row.base).toBe('1000BONK')
    expect((row.info as { multiplier: number }).multiplier).toBe(1000)
    expect(bonk.contractSize).toBe(1000)
    // The folded value the three sibling venues would produce (prefix 1000 × multiplier 1000).
    expect(bonk.contractSize).not.toBe(1_000_000)
    // The canonical *name* still drops the prefix — that is all `normalizeSymbol` is used for here.
    expect(bonk.normalized).toBe('BONK')
    expect(bonk.venueSymbol).toBe('1000BONKUSDTM')
  })

  it('sizes against a price that is already per prefixed unit ($4000 at $0.004 per 1000BONK)', () => {
    const qty = computeQty(4_000, 0.004, bonk)
    expect(qty).toBe(1_000) // 1000 contracts × 1000 × 1000BONK
    expect(venueSize(qty, bonk)).toBe(1_000)
    expect(Number.isInteger(venueSize(qty, bonk))).toBe(true)
    expect(fromVenueUnits(qty, bonk) * 0.004).toBeCloseTo(4_000, 8)
  })

  it('folding the prefix a second time would under-size this symbol by exactly 1000×', () => {
    // The counterfactual: what `../bybit/instrument.ts`'s policy would put on the Instrument.
    const folded: Instrument = { ...bonk, contractSize: bonk.contractSize * 1000 }
    expect(computeQty(4_000, 0.004, folded)).toBe(1)
    expect(computeQty(4_000, 0.004, bonk) / computeQty(4_000, 0.004, folded)).toBe(1000)
    // And the notional that 1 contract is actually worth: $4, not the $4000 the caller asked for.
    expect(fromVenueUnits(1, bonk) * 0.004).toBeCloseTo(4, 8)
  })
})
