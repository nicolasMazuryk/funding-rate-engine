/**
 * Real `Clock` adapter (`08_system_overview.md` §5; scheduler `12` §1).
 *
 * The impure edge: system time via `Date.now()` and real timers via
 * `setTimeout`/`clearTimeout`. Lives outside `src/core/` so the purity lint (0030)
 * needs no exception. Tests never use this — they use the virtual clock so no
 * `setTimeout` ever runs under test (spec `0000` §5).
 */

import type { Clock, TimerHandle } from '../../core/ports/clock.js'

export function createRealClock(): Clock {
  return {
    now(): number {
      return Date.now()
    },
    scheduleTimer(atMs: number, callback: () => void): TimerHandle {
      // A time already in the past fires on the next tick (delay clamped to 0).
      const delayMs = Math.max(0, atMs - Date.now())
      const handle = setTimeout(callback, delayMs)
      return {
        cancel(): void {
          clearTimeout(handle)
        },
      }
    },
  }
}
