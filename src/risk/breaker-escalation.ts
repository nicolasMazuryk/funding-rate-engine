/**
 * Breaker escalation (`13_risk_and_failure_modes.md` §3, task 0380): a circuit breaker that stays
 * open past the escalation bound escalates the kill switch to `flatten` (the confirmed conservative
 * target — auto reduce-only close everything). Per breaker, an `open` transition schedules a
 * `clock.scheduleTimer(now + escalationMs)`; if the breaker is still `open` when it fires,
 * `killSwitch.transition('flatten', 'breaker_open_timeout')`. Any `closed`/`half_open` transition
 * cancels the pending timer. Clock-only (no `setTimeout`) → deterministic on a virtual clock.
 */

import type { Clock, TimerHandle } from '../core/ports/clock.js'
import type { BreakerState, CircuitBreaker } from './breaker.js'
import type { KillSwitch } from './kill-switch.js'

export interface BreakerEscalationDeps {
  readonly breakers: readonly CircuitBreaker[]
  readonly killSwitch: Pick<KillSwitch, 'transition'>
  readonly clock: Clock
  /** How long a breaker may stay open before escalating to `flatten`, ms. */
  readonly escalationMs: number
}

export interface BreakerEscalation {
  /** Unsubscribe from every breaker + cancel pending escalation timers (SIGTERM teardown). */
  dispose(): void
}

export function createBreakerEscalation(deps: BreakerEscalationDeps): BreakerEscalation {
  const { breakers, killSwitch, clock, escalationMs } = deps
  const unsubscribes: Array<() => void> = []
  const timers = new Map<CircuitBreaker, TimerHandle>()

  for (const breaker of breakers) {
    const unsub = breaker.subscribe((state: BreakerState) => {
      timers.get(breaker)?.cancel()
      timers.delete(breaker)
      if (state !== 'open') return
      timers.set(
        breaker,
        clock.scheduleTimer(clock.now() + escalationMs, () => {
          // Still open at the bound → escalate. A since-recovered breaker (closed/half_open) had
          // its timer cancelled above, so this fires only for a genuinely stuck-open breaker.
          if (breaker.state() === 'open') killSwitch.transition('flatten', 'breaker_open_timeout')
        }),
      )
    })
    unsubscribes.push(unsub)
  }

  return {
    dispose(): void {
      for (const unsub of unsubscribes) unsub()
      for (const timer of timers.values()) timer.cancel()
      timers.clear()
    },
  }
}
