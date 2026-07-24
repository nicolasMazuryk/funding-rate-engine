/**
 * Unit: **`flattenAll`** — the venue-ground-truth kill-switch safety net (`13` §3/§4, task 0380).
 * Seeds multiple venue positions, flattens them reduce-only via the pure abort ladder, and proves
 * a scripted stuck position surfaces in `orphans[]` **and** publishes a last-ditch `OrphanDetected`.
 * Deterministic on the virtual clock (the ladder's backoffs are clock timers).
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { EngineEvent } from '../../../src/core/events/types.js'
import type { Instrument, OrderRequest, Position } from '../../../src/core/ports/exchange-adapter.js'
import { flattenAll } from '../../../src/risk/flatten.js'

const BACKOFFS = [250, 1000, 3000] as const

/** Drive an in-flight promise to resolution on the virtual clock (flush microtasks, advance past each backoff). */
async function settle<T>(promise: Promise<T>, clock: VirtualClock): Promise<T> {
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 40 && !done; i++) {
    await Promise.resolve()
    clock.advanceBy(3000)
  }
  return promise
}

/**
 * A minimal venue whose reduce-only close flattens the matching position — except any symbol in
 * `stuck`, whose close is a no-op (models a genuinely un-closable residual).
 */
function fakeVenue(initial: readonly Position[], stuck: ReadonlySet<string> = new Set()) {
  let positions: Position[] = [...initial]
  return {
    getPositions: (): Promise<Position[]> => Promise.resolve(positions),
    placeOrder: (req: OrderRequest) => {
      if (!stuck.has(req.symbol)) positions = positions.filter((p) => p.symbol !== req.symbol)
      return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: true })
    },
    normalize: (): Instrument => ({}) as Instrument,
    open: (): readonly Position[] => positions,
  }
}

describe('flattenAll (13 §3/§4)', () => {
  it('closes every venue position reduce-only and reports them flattened', async () => {
    const clock = createVirtualClock(0)
    const bus = createEventBus()
    const exchange = fakeVenue([
      { symbol: 'BTC', side: 'long', qty: 0.01 },
      { symbol: 'ETH', side: 'short', qty: 0.5 },
    ])

    const result = await settle(flattenAll({ exchange, clock, bus, backoffsMs: BACKOFFS }), clock)

    expect(result.flattened.sort()).toEqual(['BTC', 'ETH'])
    expect(result.orphans).toEqual([])
    expect(exchange.open()).toEqual([]) // venue is flat
  })

  it('a stuck position surfaces in orphans[] and publishes a last-ditch OrphanDetected', async () => {
    const clock = createVirtualClock(0)
    const bus = createEventBus()
    const events: EngineEvent[] = []
    bus.subscribe((e) => events.push(e))
    const exchange = fakeVenue(
      [
        { symbol: 'BTC', side: 'long', qty: 0.01 },
        { symbol: 'PEPE', side: 'short', qty: 1000 },
      ],
      new Set(['PEPE']),
    )

    const result = await settle(flattenAll({ exchange, clock, bus, backoffsMs: BACKOFFS }), clock)

    expect(result.flattened).toEqual(['BTC'])
    expect(result.orphans).toEqual([{ symbol: 'PEPE', residualQty: 1000, side: 'short' }])
    expect(events.filter((e) => e.type === 'OrphanDetected')).toEqual([
      { type: 'OrphanDetected', symbol: 'PEPE', qty: 1000, side: 'short' },
    ])
  })
})
