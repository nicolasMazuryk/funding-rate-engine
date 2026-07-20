import { describe, expect, it } from 'vitest'
import {
  AdapterError,
  AuthError,
  createConsecutiveFailureCounter,
  InsufficientBalanceError,
  NetworkError,
  NotFoundError,
  OrderRejectedError,
  RateLimitedError,
  VenueUnavailableError,
  WsTimeoutError,
} from '../../../../src/adapters/shared/errors.js'
import type { VenueErrorKind } from '../../../../src/core/ports/exchange-adapter.js'

/** Every subclass paired with the kind + retryable flag it must carry (`10` §5). */
const CASES: ReadonlyArray<{ make: () => AdapterError; kind: VenueErrorKind; retryable: boolean }> = [
  { make: () => new RateLimitedError(), kind: 'RateLimited', retryable: true },
  { make: () => new WsTimeoutError(), kind: 'WsTimeout', retryable: true },
  { make: () => new NetworkError(), kind: 'NetworkError', retryable: true },
  { make: () => new VenueUnavailableError(), kind: 'VenueUnavailable', retryable: true },
  { make: () => new OrderRejectedError(), kind: 'OrderRejected', retryable: false },
  { make: () => new InsufficientBalanceError(), kind: 'InsufficientBalance', retryable: false },
  { make: () => new AuthError(), kind: 'AuthError', retryable: false },
  { make: () => new NotFoundError(), kind: 'NotFound', retryable: false },
]

describe('AdapterError taxonomy (10 §5)', () => {
  it('stamps kind + retryable per handling column, and is an Error subclass', () => {
    for (const c of CASES) {
      const err = c.make()
      expect(err).toBeInstanceOf(AdapterError)
      expect(err).toBeInstanceOf(Error)
      expect(err.kind).toBe(c.kind)
      expect(err.retryable).toBe(c.retryable)
    }
  })

  it('carries rawCode, reason and cause through the constructor opts', () => {
    const cause = new Error('boom')
    const err = new OrderRejectedError('min notional', { rawCode: -2010, reason: 'below min', cause })
    expect(err.rawCode).toBe(-2010)
    expect(err.reason).toBe('below min')
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('min notional')
  })
})

describe('createConsecutiveFailureCounter (10 §5 breaker observer)', () => {
  it('increments only on NetworkError/VenueUnavailable', () => {
    const c = createConsecutiveFailureCounter()
    expect(c.count()).toBe(0)
    c.record(new NetworkError())
    c.record(new VenueUnavailableError())
    expect(c.count()).toBe(2)
  })

  it('does not count non-infra kinds (a one-off rejection is neither success nor infra failure)', () => {
    const c = createConsecutiveFailureCounter()
    c.record(new NetworkError())
    c.record(new OrderRejectedError()) // neither increments nor resets
    c.record(new NetworkError())
    expect(c.count()).toBe(2)
  })

  it('resets to zero on recordSuccess', () => {
    const c = createConsecutiveFailureCounter()
    c.record(new NetworkError())
    c.record(new NetworkError())
    c.recordSuccess()
    expect(c.count()).toBe(0)
  })
})
