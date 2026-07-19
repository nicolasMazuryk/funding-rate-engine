/**
 * `Clock` port (`08_system_overview.md` §5; scheduler `12` §1).
 *
 * The core reads time and schedules timers only through this port — never
 * `Date.now()` or `setTimeout` directly — so the runtime stays deterministic and
 * unit-testable against a fake clock. The concrete clock/scheduler lands in 0050.
 */

/** A cancellable scheduled timer. `cancel` is idempotent. */
export interface TimerHandle {
  cancel(): void
}

export interface Clock {
  /** Current wall-clock time, epoch ms UTC. */
  now(): number
  /**
   * Invoke `callback` at `atMs` (epoch ms UTC). A time already in the past fires
   * on the next tick. Returns a handle to cancel before it fires.
   */
  scheduleTimer(atMs: number, callback: () => void): TimerHandle
}
