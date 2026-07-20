/**
 * Typed venue-error taxonomy — the adapter-side half of `10_exchange_adapters_and_market_data.md`
 * §5. The {@link VenueErrorKind} *names* are core-visible (they ride on
 * `event.errorKind`); the *classes* here — carrying `retryable`, `rawCode`, `reason`
 * — are adapter-local, so the pure core never imports an error class (task 0200
 * decision 5). One base {@link AdapterError} plus eight named subclasses, one per
 * kind, so a call site can either discriminate on `err.kind` (the established dialect,
 * mirrors the sim) or `instanceof` a specific class.
 *
 * `retryable` is a pure function of `kind` (`10` §5 handling column): the four
 * infra/transient kinds retry, the four decision kinds do not. Subclass names append
 * `Error` to the kind, except the two kinds that already end in `Error`.
 */

import type { VenueErrorKind } from '../../core/ports/exchange-adapter.js'

/** Retryable per `10` §5 handling column — transient kinds retry, decision kinds don't. */
const RETRYABLE: Record<VenueErrorKind, boolean> = {
  RateLimited: true,
  WsTimeout: true,
  NetworkError: true,
  VenueUnavailable: true,
  OrderRejected: false,
  InsufficientBalance: false,
  AuthError: false,
  NotFound: false,
}

export interface AdapterErrorOpts {
  /** Raw venue code (numeric Binance code or HTTP status) — logged, never core-visible. */
  readonly rawCode?: string | number
  /** Venue reason text (min-notional, precision, …) — carried to the order FSM. */
  readonly reason?: string
  /** Original thrown value, preserved via `Error.cause`. */
  readonly cause?: unknown
}

/** Base class for every mapped venue error. `kind` is a closed union; `retryable` derives from it. */
export class AdapterError extends Error {
  readonly kind: VenueErrorKind
  readonly retryable: boolean
  readonly rawCode?: string | number
  readonly reason?: string

  constructor(kind: VenueErrorKind, message: string, opts: AdapterErrorOpts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'AdapterError'
    this.kind = kind
    this.retryable = RETRYABLE[kind]
    this.rawCode = opts.rawCode
    this.reason = opts.reason
  }
}

export class RateLimitedError extends AdapterError {
  constructor(message = 'venue rate limited', opts?: AdapterErrorOpts) {
    super('RateLimited', message, opts)
    this.name = 'RateLimitedError'
  }
}

export class WsTimeoutError extends AdapterError {
  constructor(message = 'ws ack timeout', opts?: AdapterErrorOpts) {
    super('WsTimeout', message, opts)
    this.name = 'WsTimeoutError'
  }
}

export class OrderRejectedError extends AdapterError {
  constructor(message = 'order rejected', opts?: AdapterErrorOpts) {
    super('OrderRejected', message, opts)
    this.name = 'OrderRejectedError'
  }
}

export class InsufficientBalanceError extends AdapterError {
  constructor(message = 'insufficient balance', opts?: AdapterErrorOpts) {
    super('InsufficientBalance', message, opts)
    this.name = 'InsufficientBalanceError'
  }
}

export class AuthError extends AdapterError {
  constructor(message = 'authentication error', opts?: AdapterErrorOpts) {
    super('AuthError', message, opts)
    this.name = 'AuthError'
  }
}

export class NetworkError extends AdapterError {
  constructor(message = 'network error', opts?: AdapterErrorOpts) {
    super('NetworkError', message, opts)
    this.name = 'NetworkError'
  }
}

export class NotFoundError extends AdapterError {
  constructor(message = 'not found', opts?: AdapterErrorOpts) {
    super('NotFound', message, opts)
    this.name = 'NotFoundError'
  }
}

export class VenueUnavailableError extends AdapterError {
  constructor(message = 'venue unavailable', opts?: AdapterErrorOpts) {
    super('VenueUnavailable', message, opts)
    this.name = 'VenueUnavailableError'
  }
}

/**
 * Consecutive-failure observer for the future circuit breaker (task 0380). Counts an
 * uninterrupted run of `NetworkError`/`VenueUnavailable` (`10` §5: those two kinds trip
 * the breaker) and resets on any observed success. This exposes the *count* only —
 * it implements no breaker; 0380 owns the trip threshold and the open/half-open FSM.
 *
 * A recorded error of any other kind neither increments nor resets: the breaker cares
 * about a run of infra failures, and a one-off `OrderRejected` in between is neither a
 * success nor an infra failure.
 */
export interface ConsecutiveFailureCounter {
  /** Observe a mapped error; increments only on `NetworkError`/`VenueUnavailable`. */
  record(err: AdapterError): void
  /** Observe a successful call; resets the run to zero. */
  recordSuccess(): void
  /** The current consecutive infra-failure count. */
  count(): number
}

export function createConsecutiveFailureCounter(): ConsecutiveFailureCounter {
  let n = 0
  return {
    record(err: AdapterError): void {
      if (err.kind === 'NetworkError' || err.kind === 'VenueUnavailable') n++
    },
    recordSuccess(): void {
      n = 0
    },
    count(): number {
      return n
    },
  }
}
