/**
 * Retracement reducer unit tests (task 0310; `03_strategy_2.md` §2/§3). The reducer is a
 * pure `(state, event) → { state, commands }` trailing state machine, so its causality
 * guarantee (R8: driven only by lows seen so far, never a future low) is a **property
 * test** over random scripted price paths — the first `fast-check` test in the repo.
 *
 * DoD coverage:
 *  - #2 causality: every emitted `P_target` is computable from the price-path prefix
 *    (prefix-replay equality) — `retracementTarget(anchor, min(prefix), r)`;
 *  - a descending new-low sequence yields monotonically non-increasing TP prices;
 *  - #4 throttle: a burst of new lows inside one virtual second yields exactly one re-place;
 *  - #3 serialize→restore: a price not below the restored `pLow` triggers no re-place.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createTrackerState,
  type RetracementCommand,
  type RetracementEvent,
  retracementReduce,
  retracementTarget,
  type TrackerState,
} from '../../../../../src/core/intent/exit-policies/retracement.js'

/** A trailing tracker (gate already armed) with the given anchor + retracement fraction. */
function trailing(anchorPrice: number, retracementPct: number): TrackerState {
  return retracementReduce(createTrackerState(anchorPrice, retracementPct), { kind: 'gateOpen' }).state
}

/** Fold a sequence of events, returning the final state and the flat command stream. */
function fold(
  initial: TrackerState,
  events: readonly RetracementEvent[],
): {
  state: TrackerState
  commands: RetracementCommand[]
} {
  let state = initial
  const commands: RetracementCommand[] = []
  for (const ev of events) {
    const result = retracementReduce(state, ev)
    state = result.state
    commands.push(...result.commands)
  }
  return { state, commands }
}

/** The TP prices emitted by a command stream, in order. */
function tpPrices(commands: readonly RetracementCommand[]): number[] {
  return commands
    .filter((c): c is Extract<RetracementCommand, { kind: 'placeTp' }> => c.kind === 'placeTp')
    .map((c) => c.price)
}

describe('retracementReduce', () => {
  it('ignores ticks in the SL-only phase (before the gate arms the tracker)', () => {
    const state = createTrackerState(100, 1)
    const { commands } = retracementReduce(state, { kind: 'tick', px: 90, nowMs: 0 })
    expect(commands).toEqual([])
  })

  it('places the first TP on the first trailing low, cancel-then-replaces on later lows', () => {
    const s0 = trailing(100, 0.5)
    const first = retracementReduce(s0, { kind: 'tick', px: 90, nowMs: 0 })
    expect(first.commands).toEqual([{ kind: 'placeTp', price: retracementTarget(100, 90, 0.5) }])
    const second = retracementReduce(first.state, { kind: 'tick', px: 80, nowMs: 2_000 })
    expect(second.commands).toEqual([{ kind: 'cancelTp' }, { kind: 'placeTp', price: retracementTarget(100, 80, 0.5) }])
  })

  it('emits close{sl_hit}/close{tp_hit} on a leg fill (alreadyFlat) and close{deadline} on the timer', () => {
    const s0 = trailing(100, 1)
    expect(retracementReduce(s0, { kind: 'fill', leg: 'sl' }).commands).toEqual([
      { kind: 'close', exitReason: 'sl_hit', alreadyFlat: true },
    ])
    expect(retracementReduce(s0, { kind: 'fill', leg: 'tp' }).commands).toEqual([
      { kind: 'close', exitReason: 'tp_hit', alreadyFlat: true },
    ])
    expect(retracementReduce(s0, { kind: 'deadline' }).commands).toEqual([
      { kind: 'close', exitReason: 'deadline', alreadyFlat: false },
    ])
  })

  it('DoD #2 causality: every emitted P_target = retracementTarget(anchor, min(prefix), r)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 100_000, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        // Prices well-spaced in virtual time (≥1 s apart) so the throttle never suppresses a low.
        fc.array(fc.double({ min: 0.01, max: 100_000, noNaN: true, noDefaultInfinity: true }), {
          minLength: 1,
          maxLength: 40,
        }),
        (anchor, r, prices) => {
          let state = trailing(anchor, r)
          let runningMin = Number.POSITIVE_INFINITY
          prices.forEach((px, i) => {
            const before = runningMin
            runningMin = Math.min(runningMin, px)
            const { state: next, commands } = retracementReduce(state, { kind: 'tick', px, nowMs: i * 1_000 })
            state = next
            const placed = tpPrices(commands)
            if (px < before) {
              // A new low → exactly one placeTp at the target derived from THIS prefix's min (= px).
              expect(placed).toEqual([retracementTarget(anchor, px, r)])
            } else {
              expect(placed).toEqual([]) // not a new low → no re-place
            }
          })
        },
      ),
    )
  })

  it('a descending new-low sequence yields monotonically non-increasing TP prices', () => {
    const { commands } = fold(trailing(100, 0.6), [
      { kind: 'tick', px: 95, nowMs: 0 },
      { kind: 'tick', px: 90, nowMs: 2_000 },
      { kind: 'tick', px: 85, nowMs: 4_000 },
      { kind: 'tick', px: 80, nowMs: 6_000 },
    ])
    const prices = tpPrices(commands)
    expect(prices).toHaveLength(4)
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThan(prices[i - 1] as number)
  })

  it('DoD #4 throttle: a burst of new lows inside one virtual second yields exactly one re-place', () => {
    const { commands, state } = fold(trailing(100, 1), [
      { kind: 'tick', px: 90, nowMs: 500 },
      { kind: 'tick', px: 89, nowMs: 700 },
      { kind: 'tick', px: 88, nowMs: 900 },
      { kind: 'tick', px: 87, nowMs: 1_100 }, // still < 1 s after the first place (at 500)
    ])
    expect(commands.filter((c) => c.kind === 'placeTp')).toHaveLength(1)
    // The running low still advances every tick even while throttled (R8).
    expect(state.pLow).toBe(87)
  })

  it('DoD #3 serialize→restore: a price not below the restored pLow triggers no re-place', () => {
    // A snapshot is plain data — "restore" is just folding onward from the persisted state.
    const restored: TrackerState = {
      phase: 'trailing',
      anchorPrice: 100,
      retracementPct: 0.5,
      pLow: 80,
      lastReplaceMs: 0,
    }
    // Not below pLow → no new low → no command (proves pLow survived the restart).
    expect(retracementReduce(restored, { kind: 'tick', px: 80, nowMs: 10_000 }).commands).toEqual([])
    expect(retracementReduce(restored, { kind: 'tick', px: 85, nowMs: 10_000 }).commands).toEqual([])
    // A lower low → re-places from the restored pLow.
    expect(retracementReduce(restored, { kind: 'tick', px: 75, nowMs: 10_000 }).commands).toEqual([
      { kind: 'cancelTp' },
      { kind: 'placeTp', price: retracementTarget(100, 75, 0.5) },
    ])
  })
})
