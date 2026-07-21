/**
 * Scripted venue-call faults for the sim adapter (task 0160) — the "rate-limit 429"
 * and "venue-unavailable streak" rows of the `13` §6 failure catalog, modelled at the
 * REST-call boundary rather than as a token bucket (that is 0200's rate limiter).
 *
 * Each of the sim's REST-shaped methods is call-counted; a scripted {@link FailSpec}
 * makes selected call ordinals throw a {@link SimVenueError} carrying a typed
 * {@link ../../core/ports/exchange-adapter.js}.VenueErrorKind. Generalized over the
 * error kind so a `RateLimited` burst and a `VenueUnavailable` streak share one path.
 * Determinism: keyed on the call ordinal only — never wall clock, never randomness.
 */

import type { VenueErrorKind } from '../../core/ports/exchange-adapter.js'

/** The REST-shaped adapter methods that can be scripted to fail (one counter each). */
export type SimCallClass =
  | 'setLeverage'
  | 'placeOrder'
  | 'cancelOrder'
  | 'getOrder'
  | 'getPositions'
  | 'getBalance'
  | 'predictedFunding'
  | 'fundingHistory'
  | 'fundingIncome'

/** Which call ordinals of a {@link SimCallClass} throw, and with what typed kind. */
export interface FailSpec {
  readonly kind: VenueErrorKind
  /** 1-based call ordinals (per call class) that throw; other calls pass through. */
  readonly failOnCallNumbers: ReadonlySet<number>
}

/** A scripted venue error thrown by a guarded sim call (`10` §5 taxonomy). */
export class SimVenueError extends Error {
  readonly kind: VenueErrorKind
  readonly callClass: SimCallClass
  constructor(kind: VenueErrorKind, callClass: SimCallClass) {
    super(`SimVenueError: ${kind} on ${callClass}`)
    this.name = 'SimVenueError'
    this.kind = kind
    this.callClass = callClass
  }
}
