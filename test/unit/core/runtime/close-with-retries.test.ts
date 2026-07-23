/**
 * Unit: **`closeWithRetries`** — the generic reduce-only abort ladder (`07_strategy_6.md` §2 step 2).
 * Drives the four paths against a fake ground-truth + a virtual clock (backoffs are clock timers):
 * happy (already flat), residual-then-flat, exhaustion (never flattens), and a getPositions
 * throw-then-recover. All deterministic on the virtual clock — no wall-clock, no randomness.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import type { Position, Side } from '../../../../src/core/ports/exchange-adapter.js'
import { closeWithRetries } from '../../../../src/core/runtime/close-with-retries.js'

const BACKOFFS = [250, 1000, 3000] as const

/** A short position of `qty` (the leg S6's abort ladder closes with a `long` reduce-only order). */
function shortPos(qty: number): Position {
  return { symbol: 'BTC', side: 'short', qty }
}

/**
 * Drive an in-flight `closeWithRetries` to resolution on the virtual clock: flush microtasks so the
 * loop schedules its next backoff timer, then advance past it — repeated until the promise settles.
 */
async function settle<T>(promise: Promise<T>, clock: VirtualClock): Promise<T> {
  let done = false
  void promise.then(() => {
    done = true
  })
  for (let i = 0; i < 30 && !done; i++) {
    await Promise.resolve()
    clock.advanceBy(3000)
  }
  return promise
}

describe('closeWithRetries (07 §2 step 2)', () => {
  it('happy: already flat → closed, no close placed', async () => {
    const clock = createVirtualClock(0)
    const placed: Array<{ attempt: number; qty: number }> = []
    const result = await settle(
      closeWithRetries({
        symbol: 'BTC',
        closeSide: 'long',
        backoffsMs: BACKOFFS,
        clock,
        placeClose: (attempt, qty) => {
          placed.push({ attempt, qty })
        },
        groundTruthFetch: () => Promise.resolve([]),
      }),
      clock,
    )
    expect(result).toEqual({ closed: true, residualQty: 0 })
    expect(placed).toHaveLength(0)
  })

  it('residual then flat: one close, second read is flat → closed', async () => {
    const clock = createVirtualClock(0)
    let positions: Position[] = [shortPos(0.01)]
    const placed: Array<{ attempt: number; qty: number }> = []
    const result = await settle(
      closeWithRetries({
        symbol: 'BTC',
        closeSide: 'long',
        backoffsMs: BACKOFFS,
        clock,
        placeClose: (attempt, qty) => {
          placed.push({ attempt, qty })
          positions = [] // the reduce-only close flattened it
        },
        groundTruthFetch: () => Promise.resolve(positions),
      }),
      clock,
    )
    expect(result).toEqual({ closed: true, residualQty: 0 })
    expect(placed).toEqual([{ attempt: 1, qty: 0.01 }])
  })

  it('exhaustion: never flattens → closed:false with the residual (orphan risk)', async () => {
    const clock = createVirtualClock(0)
    const placed: number[] = []
    const result = await settle(
      closeWithRetries({
        symbol: 'BTC',
        closeSide: 'long',
        backoffsMs: BACKOFFS,
        clock,
        placeClose: (attempt) => {
          placed.push(attempt) // close never lands — position persists
        },
        groundTruthFetch: () => Promise.resolve([shortPos(0.01)]),
      }),
      clock,
    )
    expect(result).toEqual({ closed: false, residualQty: 0.01 })
    expect(placed).toEqual([1, 2, 3]) // all three attempts tried
  })

  it('getPositions throw then recover: a failed fetch is a failed attempt, retry succeeds', async () => {
    const clock = createVirtualClock(0)
    let call = 0
    const placed: number[] = []
    const result = await settle(
      closeWithRetries({
        symbol: 'BTC',
        closeSide: 'long',
        backoffsMs: BACKOFFS,
        clock,
        placeClose: (attempt) => {
          placed.push(attempt)
        },
        groundTruthFetch: () => {
          call++
          if (call === 1) return Promise.reject(new Error('REST down')) // first attempt fails
          return Promise.resolve([]) // recovered: flat
        },
      }),
      clock,
    )
    expect(result).toEqual({ closed: true, residualQty: 0 })
    expect(placed).toHaveLength(0) // never saw a residual to close (throw, then flat)
  })

  it('closeSide selects the opposite-side residual, ignoring same-side positions', async () => {
    const clock = createVirtualClock(0)
    const sides: Side[] = []
    const result = await settle(
      closeWithRetries({
        symbol: 'BTC',
        closeSide: 'short', // closing a LONG leg
        backoffsMs: [10],
        clock,
        placeClose: () => {
          sides.push('short')
        },
        // A same-side (short) position is not the residual for a short close → treated as flat.
        groundTruthFetch: () => Promise.resolve([shortPos(0.05)]),
      }),
      clock,
    )
    expect(result).toEqual({ closed: true, residualQty: 0 })
    expect(sides).toHaveLength(0)
  })
})
