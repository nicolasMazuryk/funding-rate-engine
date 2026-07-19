/**
 * Virtual `Clock` adapter — the determinism cornerstone of the test harness
 * (`0000_agentic-development-environment.md` §5).
 *
 * Time is manual: `now()` reads an internal `nowMs`; `scheduleTimer` records a
 * pending timer; `advanceTo`/`advanceBy` fire every due timer in `(atMs, seq)`
 * order, instantly and deterministically — no `setTimeout`, no wall clock. A
 * timer registered *during* a fire (e.g. an entry timer scheduled by a scan
 * handler) is picked up in the same advance if it is due, because the pending
 * list is re-scanned each iteration.
 */

import type { Clock, TimerHandle } from '../../core/ports/clock.js'

interface PendingTimer {
  readonly atMs: number
  /** Monotonic registration order — deterministic tie-break at equal `atMs`. */
  readonly seq: number
  readonly callback: () => void
  /** Set once the timer has fired or been cancelled; either way it never fires. */
  done: boolean
}

export interface VirtualClock extends Clock {
  /** Fire all timers due at or before `ts`, then set `now()` to `ts`. */
  advanceTo(ts: number): void
  /** Advance `now()` by `ms`, firing any timers that come due. */
  advanceBy(ms: number): void
}

export function createVirtualClock(startMs = 0): VirtualClock {
  let nowMs = startMs
  let seqCounter = 0
  const pending: PendingTimer[] = []

  function nextDue(target: number): PendingTimer | undefined {
    let next: PendingTimer | undefined
    for (const timer of pending) {
      if (timer.done || timer.atMs > target) continue
      if (!next || timer.atMs < next.atMs || (timer.atMs === next.atMs && timer.seq < next.seq)) {
        next = timer
      }
    }
    return next
  }

  function fireDueUpTo(target: number): void {
    // Re-scan each iteration so a timer registered mid-fire is honoured.
    for (let timer = nextDue(target); timer !== undefined; timer = nextDue(target)) {
      timer.done = true
      // Clock is monotonic: a past-due timer (atMs < nowMs) fires without rewinding.
      if (timer.atMs > nowMs) nowMs = timer.atMs
      timer.callback()
    }
    if (target > nowMs) nowMs = target
  }

  return {
    now(): number {
      return nowMs
    },
    scheduleTimer(atMs: number, callback: () => void): TimerHandle {
      const timer: PendingTimer = { atMs, seq: seqCounter++, callback, done: false }
      pending.push(timer)
      return {
        cancel(): void {
          timer.done = true
        },
      }
    },
    advanceTo(ts: number): void {
      fireDueUpTo(ts)
    },
    advanceBy(ms: number): void {
      fireDueUpTo(nowMs + ms)
    },
  }
}
