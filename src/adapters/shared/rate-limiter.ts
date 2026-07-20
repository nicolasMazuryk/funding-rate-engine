/**
 * Per-exchange weighted token-bucket rate limiter (`10_exchange_adapters_and_market_data.md`
 * §6; reserve rule `00_globals.md` §6). One instance per adapter = one sub-account, so
 * there is no cross-instance contention by construction (`16`).
 *
 * **Two buckets, one refill schedule** (task 0200 decision 2). The order lane owns
 * `reserveFraction` of the budget, the general lane the rest; both refill from one
 * time-based schedule at their proportional share of `refillPerMs`. The order lane may
 * borrow idle general tokens; the general lane may **never** borrow the order reserve —
 * that is the "polling can never starve the order path" guarantee (§6).
 *
 * Depletion behaviour (§6): the general lane **delays** (waits for refill via the
 * {@link Clock}); the order lane **never queues** — if it cannot admit even after
 * borrowing, it throws {@link RateLimitedError} immediately so the order FSM (task 0230)
 * handles it explicitly. Clock-injected, so refill is virtual-clock testable: no
 * `Date.now()`, no real timers.
 */

import type { Clock } from '../../core/ports/clock.js'
import { RateLimitedError } from './errors.js'

/** Which lane a call draws from (`10` §6). */
export type RateLimitLane = 'order' | 'general'

export interface RateLimiter {
  /**
   * Charge `weight` tokens to `lane`. Order lane resolves immediately or throws
   * {@link RateLimitedError}; general lane resolves once enough tokens have refilled.
   */
  acquire(weight: number, lane: RateLimitLane): Promise<void>
}

export interface RateLimiterArgs {
  /** Total bucket capacity, in weight units (the full-budget high-water mark). */
  readonly capacity: number
  /** Tokens refilled per millisecond across both lanes combined. */
  readonly refillPerMs: number
  /** Fraction of capacity reserved for the order lane (e.g. `0.1` = 10%). */
  readonly reserveFraction: number
  readonly clock: Clock
}

/** Map a published venue budget to constructor args (`10` §6: "sized from exchanges.yaml"). */
export function budgetToLimiterArgs(budget: {
  readonly weightPerMinute: number
  readonly reservePct: number
}): Omit<RateLimiterArgs, 'clock'> {
  return {
    capacity: budget.weightPerMinute,
    refillPerMs: budget.weightPerMinute / 60_000,
    reserveFraction: budget.reservePct / 100,
  }
}

export function createRateLimiter(args: RateLimiterArgs): RateLimiter {
  const { capacity, refillPerMs, reserveFraction, clock } = args

  const orderCap = capacity * reserveFraction
  const generalCap = capacity - orderCap
  const orderRefillPerMs = refillPerMs * reserveFraction
  const generalRefillPerMs = refillPerMs - orderRefillPerMs

  // Both buckets start full and refill from one `lastRefillMs` schedule.
  let order = orderCap
  let general = generalCap
  let lastRefillMs = clock.now()

  /** Credit each bucket its proportional share of the tokens accrued since last refill. */
  function refill(): void {
    const nowMs = clock.now()
    const elapsed = nowMs - lastRefillMs
    if (elapsed <= 0) return
    lastRefillMs = nowMs
    order = Math.min(orderCap, order + elapsed * orderRefillPerMs)
    general = Math.min(generalCap, general + elapsed * generalRefillPerMs)
  }

  /** Order lane: consume its own tokens first, borrow idle general tokens, else throw. */
  function acquireOrder(weight: number): void {
    refill()
    if (order + general < weight) {
      throw new RateLimitedError('order lane exhausted', {
        reason: `need ${weight}, have ${(order + general).toFixed(2)} (order ${order.toFixed(2)} + general ${general.toFixed(2)})`,
      })
    }
    if (order >= weight) {
      order -= weight
      return
    }
    general -= weight - order // borrow the remainder from idle general tokens
    order = 0
  }

  /** General lane: consume only general tokens (never the order reserve); delay for refill. */
  function acquireGeneral(weight: number): Promise<void> {
    refill()
    if (general >= weight) {
      general -= weight
      return Promise.resolve()
    }
    // Wait exactly long enough for the deficit to refill, then re-check (another
    // waiter may have consumed in the meantime — recursion converges deterministically).
    const deficit = weight - general
    const waitMs = Math.ceil(deficit / generalRefillPerMs)
    return new Promise<void>((resolve) => {
      clock.scheduleTimer(clock.now() + waitMs, resolve)
    }).then(() => acquireGeneral(weight))
  }

  return {
    acquire(weight: number, lane: RateLimitLane): Promise<void> {
      if (lane === 'order') {
        acquireOrder(weight)
        return Promise.resolve()
      }
      return acquireGeneral(weight)
    },
  }
}
