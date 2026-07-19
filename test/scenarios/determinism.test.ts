/**
 * Determinism gate (task 0160 DoD 3; `0000` §5). Running one scenario twice from a
 * fresh harness must yield byte-identical traces — the property that lets every future
 * strategy task trust the sim as a replayable oracle. The scenario deliberately mixes
 * faults (partial fills, a duplicated update, a delayed funding fee) so the guarantee
 * covers the fault paths, not just the happy path.
 */

import { describe, expect, it } from 'vitest'
import { stableStringify } from '../helpers/stable-stringify.js'
import { fault, placeOrder, scenario, setPrice } from './dsl.js'
import { runScenario } from './run-scenario.js'

const faultScenario = scenario('mixed-faults')
  .at(
    10,
    fault((h) => h.exchange.scriptPartialFills('lim', [1, 1, 1])),
  )
  .at(10, placeOrder({ symbol: 'PEPE', side: 'long', type: 'limit', qty: 3, price: 0.01, clientOrderId: 'lim' }))
  .at(20, setPrice('PEPE', 0.01)) // partial 1
  .at(30, setPrice('PEPE', 0.01)) // partial 2
  .at(40, setPrice('PEPE', 0.01)) // fill 3 → long position open
  .at(
    50,
    fault((h) => h.exchange.duplicateNextOrderUpdate()),
  )
  .at(
    60,
    fault((h) => h.exchange.delayFundingFee(100)),
  )
  .at(
    70,
    fault((h) => h.exchange.settleFunding('PEPE', -0.4, 70)),
  )
  .at(200, setPrice('PEPE', 0.01)) // advance the clock past the funding-fee delay (170)
  .build()

describe('scenario determinism', () => {
  it('produces byte-identical traces across two fresh runs', () => {
    const a = runScenario(faultScenario)
    const b = runScenario(faultScenario)
    try {
      expect(stableStringify(a.trace)).toBe(stableStringify(b.trace))
      expect(a.trace.length).toBeGreaterThan(0)
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })
})
