/**
 * Unit: the **contract-size chain** — task 0430's first definition-of-done, and the reason OKX
 * is worth building as venue three.
 *
 * `src/core/sizing/sizing.ts` has divided by `Instrument.contractSize` since task 0120, but no
 * test above the pure sizing unit test has ever used a non-unit value: Binance and Bybit carry
 * `contractSize: 1` on everything except their `1000X` multiplier listings, and those are
 * exercised only in the symbol-normalization tests. OKX sizes in **contracts** with a
 * per-instrument face value (`ctVal`), so roughly half its universe is `≠ 1` — and a wrong
 * `contractSize` there silently mis-sizes every order rather than failing.
 *
 * So this walks one real captured fixture end to end and asserts the string the venue would
 * actually receive:
 *
 *   `ctval-100-xrp.json` (`ctVal: "100"`) → `ccxtMarketToInstrument` → `computeQty` →
 *   the `sz` `./ws-orders.ts` puts on the wire → `fromVenueUnits` back to base units.
 *
 * A note on `toVenueUnits` (`src/core/sizing/denomination.ts`): it is **not** in this chain,
 * and must not be. `computeQty` is `amountUsd / price / contractSize`, so its output is
 * already a contract count — the same unit `sz`, `minQty` and `amountPrecision` are in.
 * Applying `toVenueUnits` on top would divide by `contractSize` a second time and under-size
 * every OKX order 100-fold on this symbol. `fromVenueUnits` is the direction that *is* well
 * defined here: contracts → base units, which is what makes the notional assertion below
 * meaningful.
 */

import { describe, expect, it } from 'vitest'
import { ccxtMarketToInstrument } from '../../../../../src/adapters/exchanges/okx/instrument.js'
import { fromVenueUnits } from '../../../../../src/core/sizing/denomination.js'
import { checkFeasibility, computeQty, minFeasibleQty } from '../../../../../src/core/sizing/sizing.js'
import { loadMarket } from './fixtures.js'

/** The `sz` string `toOrderParams` builds — the exact value the venue receives. */
function venueSz(qty: number): string {
  return String(qty)
}

describe('contract-size chain (DoD 1) — a real ctVal ≠ 1 instrument', () => {
  const xrp = ccxtMarketToInstrument(loadMarket('ctval-100-xrp'))
  const btc = ccxtMarketToInstrument(loadMarket('clean-perp-btc'))

  it('carries the venue face value onto the Instrument (ctVal × ctMult, not a name prefix)', () => {
    expect(xrp.contractSize).toBe(100) // 1 XRP-USDT-SWAP contract = 100 XRP
    expect(btc.contractSize).toBe(0.01) // 1 BTC-USDT-SWAP contract = 0.01 BTC
  })

  it('sizes $1000 at $2.00 into 5 contracts and sends sz "5" — not 500', () => {
    const qty = computeQty(1_000, 2, xrp)
    expect(qty).toBe(5)
    expect(venueSz(qty)).toBe('5')
    // 500 would be the base-unit count; sending it is a 100× over-size.
    expect(venueSz(qty)).not.toBe('500')
  })

  it('the contracts sent are worth the notional asked for (contracts × ctVal × price)', () => {
    const qty = computeQty(1_000, 2, xrp)
    expect(fromVenueUnits(qty, xrp) * 2).toBeCloseTo(1_000, 8)
  })

  it('the same math on a sub-unit contract size: $1000 at $100k BTC → 1 contract of 0.01 BTC', () => {
    const qty = computeQty(1_000, 100_000, btc)
    expect(qty).toBe(1)
    expect(fromVenueUnits(qty, btc) * 100_000).toBeCloseTo(1_000, 8)
  })

  it('floors to the venue lot step in contracts, so a partial contract is never sent', () => {
    // $1050 at $2.00 = 5.25 contracts; lotSz/amountPrecision is 0.01, so 5.25 survives whole.
    expect(computeQty(1_050, 2, xrp)).toBeCloseTo(5.25, 10)
    // A qty finer than the lot step floors down rather than rounding up into an over-size.
    expect(computeQty(1_000.5, 2, xrp)).toBeCloseTo(5, 10)
  })

  it('feasibility reads the same units — minQty is in contracts, so $5 at $2.00 clears minSz', () => {
    const qty = computeQty(5, 2, xrp)
    expect(qty).toBeCloseTo(0.02, 10) // 0.02 contracts = 2 XRP
    expect(checkFeasibility(qty, 2, xrp)).toEqual({ ok: true })
    // Below the venue's 0.01-contract minimum the order is skipped, never coerced up.
    expect(checkFeasibility(computeQty(1, 2, xrp), 2, xrp).ok).toBe(false)
  })

  it('minFeasibleQty is a contract count too (S6 pre-funding leg sizing)', () => {
    // OKX publishes no per-instrument min notional, so the floor is minSz alone.
    expect(xrp.minNotional).toBe(0)
    expect(minFeasibleQty(2, xrp)).toBe(xrp.minQty)
  })
})
