/**
 * Generic circuit-breaker FSM (`13_risk_and_failure_modes.md` §3, task 0380) — the venue-agnostic
 * three-state machine driving both the venue-io breaker (trips on a run of `NetworkError` /
 * `VenueUnavailable`) and the order breaker (trips on a run of `OrderRejected`).
 *
 * It **implements** {@link ConsecutiveFailureCounter} so it drops straight into the adapter's
 * `deps.failures` slot (`callGeneral` feeds it `record`/`recordSuccess`), and adds the breaker
 * surface — `isOpen()` (the sole preflight consultation), `state()`, `openSinceMs()`,
 * `subscribe()`, `dispose()`. Time comes only from the injected {@link Clock}, so it is fully
 * deterministic on a virtual clock.
 *
 * FSM: `record(err)` counts only when `counts(err)`; at `n >= threshold` from `closed` it goes
 * **open** (stamps `openSinceMs`, schedules a `clock.scheduleTimer(now + cooldownMs)` → `half_open`,
 * notifies). `recordSuccess()` resets the run in `closed`, and in `half_open` **closes**. In
 * `half_open` a counted error re-**opens**. `isOpen()` is true only in `open` — `half_open` admits
 * the probe (ambient adapter traffic) and a new intent. Duck-types on `err.kind`, so both the
 * adapter's `AdapterError` and the sim's `SimVenueError` feed it.
 */

import type { ConsecutiveFailureCounter } from '../adapters/shared/errors.js'
import type { Unsubscribe } from '../core/ports/bus.js'
import type { Clock, TimerHandle } from '../core/ports/clock.js'
import type { VenueErrorKind } from '../core/ports/exchange-adapter.js'

/** The three breaker states (`13` §3). `isOpen()` (admission control) is true only in `open`. */
export type BreakerState = 'closed' | 'open' | 'half_open'

/** The minimal fault shape the breaker observes — both `AdapterError` and `SimVenueError` carry `kind`. */
export type BreakerFault = { readonly kind: VenueErrorKind }

export interface CircuitBreaker extends ConsecutiveFailureCounter {
  /**
   * Observe a fault. Widened from {@link ConsecutiveFailureCounter.record}'s `AdapterError` to the
   * minimal {@link BreakerFault} so both the adapter's `AdapterError` and the sim's `SimVenueError`
   * (and the order feed's synthetic `{kind:'OrderRejected'}`) feed it — it only reads `err.kind`.
   */
  record(err: BreakerFault): void
  /** True only in `open` — the preflight consultation. `half_open` returns false (admits a probe/new intent). */
  isOpen(): boolean
  state(): BreakerState
  /** Instant the breaker last opened, epoch ms, or `undefined` while closed. */
  openSinceMs(): number | undefined
  /** Register a state-change listener; returns an idempotent unsubscribe. */
  subscribe(fn: (state: BreakerState) => void): Unsubscribe
  /** Cancel the pending cooldown timer + drop subscribers (SIGTERM teardown). */
  dispose(): void
}

export interface CircuitBreakerParams {
  readonly clock: Clock
  /** Consecutive counted errors that trip `closed → open`. */
  readonly threshold: number
  /** `open → half_open` probe delay, ms. */
  readonly cooldownMs: number
  /** Which errors count toward the trip; default: `NetworkError` / `VenueUnavailable` (`10` §5). */
  readonly counts?: (err: BreakerFault) => boolean
}

/** The default counted kinds — the two infra/outage kinds that trip the venue-io breaker (`10` §5). */
function defaultCounts(err: BreakerFault): boolean {
  return err.kind === 'NetworkError' || err.kind === 'VenueUnavailable'
}

export function createCircuitBreaker(params: CircuitBreakerParams): CircuitBreaker {
  const { clock, threshold, cooldownMs } = params
  const counts = params.counts ?? defaultCounts

  let state: BreakerState = 'closed'
  let n = 0
  let openSince: number | undefined
  let cooldownHandle: TimerHandle | undefined
  const subscribers = new Set<(state: BreakerState) => void>()

  function notify(): void {
    for (const fn of subscribers) fn(state)
  }

  function open(): void {
    state = 'open'
    openSince = clock.now()
    n = 0
    cooldownHandle?.cancel()
    // Ambient adapter traffic is the probe; the timer only lifts the block to half_open.
    cooldownHandle = clock.scheduleTimer(clock.now() + cooldownMs, () => {
      if (state !== 'open') return
      state = 'half_open'
      notify()
    })
    notify()
  }

  function close(): void {
    state = 'closed'
    n = 0
    openSince = undefined
    cooldownHandle?.cancel()
    cooldownHandle = undefined
    notify()
  }

  return {
    record(err: BreakerFault): void {
      if (!counts(err)) return
      if (state === 'open') return // cooldown pending — a counted error while open is a no-op
      if (state === 'half_open') {
        open() // the probe failed → straight back to open
        return
      }
      n++
      if (n >= threshold) open()
    },
    recordSuccess(): void {
      if (state === 'half_open') {
        close() // the probe succeeded → heal
        return
      }
      if (state === 'closed') n = 0 // a success interrupts a partial run
      // In `open`, a success is ignored: admission stays blocked until the cooldown lifts to half_open.
    },
    count(): number {
      return n
    },
    isOpen(): boolean {
      return state === 'open'
    },
    state(): BreakerState {
      return state
    },
    openSinceMs(): number | undefined {
      return openSince
    },
    subscribe(fn: (state: BreakerState) => void): Unsubscribe {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    dispose(): void {
      cooldownHandle?.cancel()
      cooldownHandle = undefined
      subscribers.clear()
    },
  }
}
