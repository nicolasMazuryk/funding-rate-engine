/**
 * Scheduler — pure core (`12_strategy_runtime_and_intent_lifecycle.md` §1).
 *
 * Turns `Clock` ticks into `Timer` events on the bus. It is deliberately free of
 * strategy knowledge (`12` §1): it schedules the *instants it is told* and never
 * computes `T_settle`, the funding interval, or `entryOffsetSeconds` — those are
 * re-read per event by the caller (`00_globals.md` §8.1). Only the hourly `HH:58`
 * scan boundary is derived here (a fixed wall-clock rule, not strategy state).
 *
 * Depends only on ports (`Clock`, `EventBus`); the concrete clock/bus are wired
 * in `main.ts`.
 */

import type { Timer } from '../events/types.js'
import type { EventBus } from '../ports/bus.js'
import type { Clock, TimerHandle } from '../ports/clock.js'

const HOUR_MS = 3_600_000
/** Offset of the scan boundary within the hour: `HH:58:00` = 58 min. */
const SCAN_OFFSET_MS = 58 * 60_000

/** First `HH:58:00` strictly after `nowMs` (epoch ms UTC). */
function nextScanBoundary(nowMs: number): number {
  const boundary = nowMs - (nowMs % HOUR_MS) + SCAN_OFFSET_MS
  // `<=` (not `<`): rescheduling from a boundary that just fired must skip to the
  // next hour, otherwise it would re-fire at the same instant forever.
  return boundary <= nowMs ? boundary + HOUR_MS : boundary
}

export interface Scheduler {
  /** Schedule the first `HH:58:00` scan; each fire self-perpetuates to the next hour. */
  start(): void
  /** Cancel the scan timer (clean teardown). Idempotent. */
  stop(): void
  /** One-shot `entry` timer at `atMs` (caller passes `T_settle − entryOffsetSeconds`). */
  scheduleEntryTimer(symbol: string, atMs: number): TimerHandle
  /** One-shot `deadline` timer at `atMs` for `intentId` (exit policy owns the instant). */
  scheduleDeadlineTimer(intentId: string, atMs: number): TimerHandle
}

export function createScheduler(clock: Clock, bus: EventBus): Scheduler {
  let scanHandle: TimerHandle | undefined

  function scheduleScan(atMs: number): void {
    scanHandle = clock.scheduleTimer(atMs, () => {
      bus.publish({ type: 'Timer', kind: 'scan', ts: atMs })
      scheduleScan(nextScanBoundary(atMs))
    })
  }

  return {
    start(): void {
      scheduleScan(nextScanBoundary(clock.now()))
    },
    stop(): void {
      scanHandle?.cancel()
      scanHandle = undefined
    },
    scheduleEntryTimer(symbol: string, atMs: number): TimerHandle {
      return clock.scheduleTimer(atMs, () => {
        const event: Timer = { type: 'Timer', kind: 'entry', ts: atMs, symbol }
        bus.publish(event)
      })
    },
    scheduleDeadlineTimer(intentId: string, atMs: number): TimerHandle {
      return clock.scheduleTimer(atMs, () => {
        const event: Timer = { type: 'Timer', kind: 'deadline', ts: atMs, intentId }
        bus.publish(event)
      })
    },
  }
}
