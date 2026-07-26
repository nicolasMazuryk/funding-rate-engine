/**
 * Unit: the **contract-size chain** on Bitget — the venue-specific analogue of
 * `../okx/contract-size-chain.test.ts`, walking one captured fixture from ccxt market through
 * `Instrument` and `computeQty` to the `qty` string `./ws-orders.ts` puts on the wire.
 *
 * On OKX the load-bearing value is a venue face value (`ctVal`): the venue itself tells you a
 * BTC contract is 0.01 BTC, and the adapter's job is to carry that number through without
 * losing it. **Bitget has no such number.** `contractSize` is `1` on every one of its 721
 * linear listings, and the raw row publishes nothing else that means "base units per contract"
 * (`info.sizeMultiplier` reads like one but is the quantity step). The only face value on this
 * venue is the one encoded in the *symbol name* — `1000BONKUSDT` trades in thousands of BONK —
 * and it exists nowhere in the payload except as four characters of a string.
 *
 * That inversion is why this file is worth writing separately. The number under test is
 * **synthesized by the adapter** (`normalizeSymbol` → `contractSize: 1 × 1000`), not read from
 * the venue, so nothing downstream can cross-check it: if the fold is dropped the instrument
 * still looks perfectly well-formed at `contractSize: 1` and every order on the symbol is 1000×
 * too large. And if the fold is applied **twice** — once at map time and again via
 * `toVenueUnits` at the API boundary — the order is 1000× too small. Both directions are silent.
 *
 * So the chain asserted here is:
 *
 *   `multiplier-1000-bonk.json` (`base: "1000BONK"`, `contractSize: 1`) →
 *   `ccxtMarketToInstrument` (contractSize 1000) → `computeQty` → the `qty` string →
 *   `fromVenueUnits` back to BONK, whose notional must be the dollars asked for.
 *
 * As on OKX, `toVenueUnits` (`src/core/sizing/denomination.ts`) is deliberately **not** in the
 * chain: `computeQty` is `amountUsd / price / contractSize`, so its output is already in the
 * venue's own quantity unit — the same unit `qty`, `minOrderQty` and `amountPrecision` are in.
 * Applying `toVenueUnits` on top divides by the multiplier a second time. `fromVenueUnits` is
 * the direction that is well defined: venue units → BONK, which is what makes the notional
 * assertions below meaningful. Prices throughout are USD per **base unit** (per BONK), the
 * denomination `10` §4 keeps the core in.
 */

import { describe, expect, it } from 'vitest'
import { ccxtMarketToInstrument } from '../../../../../src/adapters/exchanges/bitget/instrument.js'
import { fromVenueUnits } from '../../../../../src/core/sizing/denomination.js'
import { checkFeasibility, computeQty, minFeasibleQty } from '../../../../../src/core/sizing/sizing.js'
import { loadMarket } from './fixtures.js'

/** The `qty` string `toOrderCore` builds — the exact value the venue receives. */
function venueQty(qty: number): string {
  return String(qty)
}

describe('contract-size chain — the multiplier fold is the only face value on Bitget', () => {
  const bonk = ccxtMarketToInstrument(loadMarket('multiplier-1000-bonk'))
  const mog = ccxtMarketToInstrument(loadMarket('multiplier-1000000-mog'))
  const btc = ccxtMarketToInstrument(loadMarket('clean-perp-btc'))

  /** USD per BONK. The venue quotes `1000BONKUSDT` at 1000× this. */
  const bonkPrice = 0.00002

  it('synthesizes contractSize from the symbol prefix, since the venue publishes 1', () => {
    expect(loadMarket('multiplier-1000-bonk').contractSize).toBe(1) // what Bitget says
    expect(bonk.contractSize).toBe(1000) // what the instrument means
    expect(mog.contractSize).toBe(1_000_000)
    expect(btc.contractSize).toBe(1) // no prefix, so venue and instrument agree
  })

  it('sizes $1000 of BONK into 50000 venue units and sends qty "50000" — not 50, not 50000000', () => {
    const qty = computeQty(1_000, bonkPrice, bonk)
    expect(qty).toBe(50_000)
    expect(venueQty(qty)).toBe('50000')
    // 50000000 is the BONK count — the fold not applied at all, a 1000× over-size.
    expect(venueQty(qty)).not.toBe('50000000')
    // 50 is the fold applied twice (computeQty then toVenueUnits) — a 1000× under-size.
    expect(venueQty(qty)).not.toBe('50')
  })

  it('the units sent are worth the notional asked for (venue units × 1000 BONK × price)', () => {
    const qty = computeQty(1_000, bonkPrice, bonk)
    expect(fromVenueUnits(qty, bonk)).toBe(50_000_000) // 50 million BONK
    expect(fromVenueUnits(qty, bonk) * bonkPrice).toBeCloseTo(1_000, 8)
  })

  it('the same math at the largest live multiplier (1000000MOG)', () => {
    const mogPrice = 0.0000005 // USD per MOG
    const qty = computeQty(1_000, mogPrice, mog)
    expect(qty).toBe(2_000)
    expect(fromVenueUnits(qty, mog) * mogPrice).toBeCloseTo(1_000, 8)
  })

  it('a plain listing is untouched by the fold: $1000 at $100k BTC → 0.01 BTC', () => {
    const qty = computeQty(1_000, 100_000, btc)
    expect(qty).toBe(0.01)
    expect(fromVenueUnits(qty, btc) * 100_000).toBeCloseTo(1_000, 8)
  })

  it('floors to the venue lot step in venue units, so a partial unit is never sent', () => {
    // `amountPrecision` is 1 on 1000BONKUSDT — whole thousands of BONK only.
    expect(bonk.amountPrecision).toBe(1)
    // $1000 at $0.0000201/BONK = 49751.24… venue units; the fraction is dropped, not rounded up.
    expect(computeQty(1_000, 0.0000201, bonk)).toBe(49_751)
    // An exact multiple survives whole rather than losing a quantum to float drift.
    expect(computeQty(1_000, bonkPrice, bonk)).toBe(50_000)
  })

  it('a sub-lot order floors to zero and is skipped, never coerced up to one unit', () => {
    // $0.01 buys half a venue unit (500 BONK); one whole unit would be a 2× over-size.
    const qty = computeQty(0.01, bonkPrice, bonk)
    expect(qty).toBe(0)
    expect(checkFeasibility(qty, bonkPrice, bonk)).toEqual({ ok: false, reason: 'zero_qty' })
  })

  it('minFeasibleQty is a venue-unit count worth the min notional (S6 pre-funding leg)', () => {
    expect(bonk.minNotional).toBe(5) // Bitget's minTradeUSDT
    expect(bonk.minQty).toBe(1) // one venue unit = 1000 BONK
    // The notional floor binds here, not the lot floor: $5 / ($0.00002 × 1000) = 250 units.
    const preQty = minFeasibleQty(bonkPrice, bonk)
    expect(preQty).toBe(250)
    expect(fromVenueUnits(preQty, bonk) * bonkPrice).toBeCloseTo(5, 8)
  })

  it('on a plain listing the lot floor binds instead, and both floors are venue units', () => {
    // $5 at $100k is 0.00005 BTC, below the 0.0001 lot minimum, so minQty wins.
    expect(minFeasibleQty(100_000, btc)).toBe(btc.minQty)
    expect(checkFeasibility(minFeasibleQty(100_000, btc), 100_000, btc)).toEqual({ ok: true })
  })
})
