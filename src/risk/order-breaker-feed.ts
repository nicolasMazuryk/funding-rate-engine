/**
 * Order-breaker bus feed + live-intent escalation (`13_risk_and_failure_modes.md` §3, task 0380).
 *
 * The order breaker is fed from the bus (not a `callOrder` throw, which would miss a `FAILED`
 * status the venue reports out-of-band): each `OrderUpdate` with status `REJECTED`/`FAILED` is an
 * `OrderRejected` fault → `breaker.record`; a `FILLED` terminal → `breaker.recordSuccess`. When the
 * order breaker transitions to `open` **while a live intent exists** (`hasLiveIntent()`), the kill
 * switch escalates to `paused` (`13` §3: recurring order rejects during a live intent → paused).
 */

import type { EventBus, Unsubscribe } from '../core/ports/bus.js'
import type { CircuitBreaker } from './breaker.js'
import type { KillSwitch } from './kill-switch.js'

export interface OrderBreakerFeedDeps {
  readonly bus: EventBus
  readonly breaker: CircuitBreaker
  readonly killSwitch: Pick<KillSwitch, 'transition'>
  /** Whether the engine currently owns a live (non-terminal) intent — the escalation guard. */
  readonly hasLiveIntent: () => boolean
}

/** Wire the order breaker to the bus; returns an unsubscribe that drops both listeners. */
export function wireOrderBreakerFeed(deps: OrderBreakerFeedDeps): Unsubscribe {
  const { bus, breaker, killSwitch, hasLiveIntent } = deps

  // Escalate the moment the order breaker opens, if an intent is live at that instant.
  const unsubBreaker = breaker.subscribe((state) => {
    if (state === 'open' && hasLiveIntent()) killSwitch.transition('paused', 'order_breaker_open')
  })

  const unsubBus: Unsubscribe = bus.subscribe((event) => {
    if (event.type !== 'OrderUpdate') return
    if (event.status === 'REJECTED' || event.status === 'FAILED') {
      breaker.record({ kind: 'OrderRejected' })
    } else if (event.status === 'FILLED') {
      breaker.recordSuccess()
    }
  })

  return () => {
    unsubBreaker()
    unsubBus()
  }
}
