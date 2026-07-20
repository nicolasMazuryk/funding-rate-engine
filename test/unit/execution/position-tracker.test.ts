/**
 * Unit: position tracker (`11` §8/§9, `00_globals` §5.3 orphans). Driven against the real
 * event bus + virtual clock + a scriptable fake `getPositions`, fully offline. Covers:
 * folding `PositionUpdate` into tracked state, REST-wins reconciliation on divergence,
 * orphan detection (venue position with no owning intent), the self-re-arming reconcile
 * tick, REST-failure keeping tracked state, and `initialPositions` seeding.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../src/adapters/clock/virtual-clock.js'
import { createEventBus } from '../../../src/core/events/bus.js'
import type { OrphanDetected } from '../../../src/core/events/types.js'
import type { EventBus } from '../../../src/core/ports/bus.js'
import type { Position } from '../../../src/core/ports/exchange-adapter.js'
import { createPositionTracker, type PositionTracker } from '../../../src/execution/position-tracker.js'

interface Harness {
  readonly tracker: PositionTracker
  readonly bus: EventBus
  readonly clock: ReturnType<typeof createVirtualClock>
  readonly orphans: OrphanDetected[]
  setVenue(positions: Position[]): void
  failNextGetPositions(): void
}

function harness(opts: {
  hasOwningIntent?: (symbol: string) => boolean
  initialPositions?: Position[]
  reconcileIntervalMs?: number
}): Harness {
  const clock = createVirtualClock(0)
  const bus = createEventBus()
  const orphans: OrphanDetected[] = []
  bus.subscribe((e) => {
    if (e.type === 'OrphanDetected') orphans.push(e)
  })
  let venue: Position[] = []
  let failOnce = false

  const tracker = createPositionTracker({
    bus,
    clock,
    exchange: {
      getPositions() {
        if (failOnce) {
          failOnce = false
          return Promise.reject(new Error('getPositions failed'))
        }
        return Promise.resolve(venue)
      },
    },
    hasOwningIntent: opts.hasOwningIntent ?? (() => true),
    reconcileIntervalMs: opts.reconcileIntervalMs ?? 60_000,
    ...(opts.initialPositions ? { initialPositions: opts.initialPositions } : {}),
  })

  return {
    tracker,
    bus,
    clock,
    orphans,
    setVenue: (p) => {
      venue = p
    },
    failNextGetPositions: () => {
      failOnce = true
    },
  }
}

describe('position tracker — PositionUpdate folding', () => {
  it('records a PositionUpdate and drops it when qty goes to zero (flat)', () => {
    const h = harness({})
    h.bus.publish({ type: 'PositionUpdate', symbol: 'BTC', qty: 0.5, side: 'long' })
    expect(h.tracker.get('BTC')).toEqual({ symbol: 'BTC', side: 'long', qty: 0.5 })

    h.bus.publish({ type: 'PositionUpdate', symbol: 'BTC', qty: 0, side: 'long' })
    expect(h.tracker.get('BTC')).toBeUndefined()
    h.tracker.dispose()
  })

  it('seeds from initialPositions (reprime / recovery)', () => {
    const h = harness({ initialPositions: [{ symbol: 'ETH', side: 'short', qty: 2, entryPrice: 3_000 }] })
    expect(h.tracker.get('ETH')).toEqual({ symbol: 'ETH', side: 'short', qty: 2, entryPrice: 3_000 })
    h.tracker.dispose()
  })
})

describe('position tracker — reconcile (REST wins)', () => {
  it('replaces tracked state with venue truth on divergence', async () => {
    const h = harness({})
    h.bus.publish({ type: 'PositionUpdate', symbol: 'BTC', qty: 0.5, side: 'long' })
    // Venue disagrees: smaller size. REST wins.
    h.setVenue([{ symbol: 'BTC', side: 'long', qty: 0.3, entryPrice: 60_000 }])

    await h.tracker.reconcile()

    expect(h.tracker.get('BTC')).toEqual({ symbol: 'BTC', side: 'long', qty: 0.3, entryPrice: 60_000 })
    h.tracker.dispose()
  })

  it('drops a tracked position the venue no longer reports', async () => {
    const h = harness({})
    h.bus.publish({ type: 'PositionUpdate', symbol: 'BTC', qty: 0.5, side: 'long' })
    h.setVenue([]) // venue flat

    await h.tracker.reconcile()

    expect(h.tracker.get('BTC')).toBeUndefined()
    h.tracker.dispose()
  })

  it('keeps tracked state (no wipe) when getPositions throws', async () => {
    const h = harness({})
    h.bus.publish({ type: 'PositionUpdate', symbol: 'BTC', qty: 0.5, side: 'long' })
    h.failNextGetPositions()

    await h.tracker.reconcile()

    expect(h.tracker.get('BTC')).toEqual({ symbol: 'BTC', side: 'long', qty: 0.5 })
    h.tracker.dispose()
  })
})

describe('position tracker — orphan detection (`00_globals` §5.3)', () => {
  it('fires onOrphan for a venue position with no owning intent', async () => {
    const h = harness({ hasOwningIntent: () => false })
    h.setVenue([{ symbol: 'BTC', side: 'long', qty: 0.3, entryPrice: 60_000 }])

    await h.tracker.reconcile()

    expect(h.orphans).toEqual([{ type: 'OrphanDetected', symbol: 'BTC', qty: 0.3, side: 'long' }])
    h.tracker.dispose()
  })

  it('does not fire onOrphan when an intent owns the symbol', async () => {
    const h = harness({ hasOwningIntent: (s) => s === 'BTC' })
    h.setVenue([{ symbol: 'BTC', side: 'long', qty: 0.3 }])

    await h.tracker.reconcile()

    expect(h.orphans).toEqual([])
    h.tracker.dispose()
  })
})

describe('position tracker — periodic tick', () => {
  it('self-re-arms and reconciles on each interval', async () => {
    const h = harness({ hasOwningIntent: () => false, reconcileIntervalMs: 10_000 })
    h.setVenue([{ symbol: 'BTC', side: 'long', qty: 0.3 }])

    h.clock.advanceTo(10_000) // first tick
    await Promise.resolve()
    await Promise.resolve()
    h.clock.advanceTo(20_000) // second tick — proves re-arm
    await Promise.resolve()
    await Promise.resolve()

    // Orphan fired on each reconcile (two ticks).
    expect(h.orphans.length).toBe(2)
    h.tracker.dispose()
  })
})
