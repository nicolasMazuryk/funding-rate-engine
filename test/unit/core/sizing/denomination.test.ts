import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import { fromVenueUnits, toVenueUnits } from '../../../../src/core/sizing/denomination.js'

/** `1000PEPE` venue symbol normalized to `PEPE`, `contractSize = 1000` (`10` §4 example). */
const PEPE: Instrument = {
  normalized: 'PEPE',
  venueSymbol: '1000PEPEUSDT',
  contractSize: 1000,
  pricePrecision: 0.0000001,
  amountPrecision: 1,
  minNotional: 5,
  minQty: 1,
  fundingIntervalHours: 8,
}

const BTC: Instrument = { ...PEPE, normalized: 'BTC', venueSymbol: 'BTCUSDT', contractSize: 1 }

describe('denomination (10 §4)', () => {
  it('converts base units to venue contract units (1000PEPE example)', () => {
    // 10_000 PEPE base units = 10 venue contracts of 1000 PEPE each.
    expect(toVenueUnits(10_000, PEPE)).toBe(10)
  })

  it('converts venue contract units back to base units', () => {
    expect(fromVenueUnits(10, PEPE)).toBe(10_000)
  })

  it('is identity for contractSize 1 (no multiple)', () => {
    expect(toVenueUnits(0.5, BTC)).toBe(0.5)
    expect(fromVenueUnits(0.5, BTC)).toBe(0.5)
  })

  it('round-trips a contract-aligned qty exactly (toVenueUnits ∘ fromVenueUnits = id)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (contracts) => {
        // A whole number of contracts is exactly contract-aligned.
        const base = fromVenueUnits(contracts, PEPE)
        expect(toVenueUnits(base, PEPE)).toBe(contracts)
      }),
    )
  })
})
