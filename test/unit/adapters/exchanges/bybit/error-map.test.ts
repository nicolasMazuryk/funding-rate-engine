/**
 * Unit: Bybit venue-error mapping (`10` §5). Mirrors the Binance sibling's structure —
 * ccxt class cases, venue-code cases, code-wins-over-class, unknown → retryable
 * `NetworkError` with `onUnknown` fired, idempotency. The Bybit-specific cases are the
 * three shapes a `retCode` can arrive in: on the raw native body, on a lifted
 * `Error.code` (WS trade API), and embedded in a ccxt message JSON blob.
 */

import {
  AuthenticationError,
  DDoSProtection,
  ExchangeError,
  ExchangeNotAvailable,
  InsufficientFunds,
  InvalidOrder,
  OnMaintenance,
  OrderNotFound,
  PermissionDenied,
  RateLimitExceeded,
  RequestTimeout,
} from 'ccxt'
import { describe, expect, it } from 'vitest'
import { mapBybitError } from '../../../../../src/adapters/exchanges/bybit/error-map.js'
import { AdapterError } from '../../../../../src/adapters/shared/errors.js'
import type { VenueErrorKind } from '../../../../../src/core/ports/exchange-adapter.js'

/** ccxt class instances → expected kind (message carries no numeric code). */
const CLASS_CASES: ReadonlyArray<{ name: string; err: Error; kind: VenueErrorKind; retryable: boolean }> = [
  { name: 'RateLimitExceeded', err: new RateLimitExceeded('rate limited'), kind: 'RateLimited', retryable: true },
  { name: 'DDoSProtection', err: new DDoSProtection('ddos'), kind: 'RateLimited', retryable: true },
  { name: 'RequestTimeout', err: new RequestTimeout('timed out'), kind: 'NetworkError', retryable: true },
  { name: 'OnMaintenance', err: new OnMaintenance('maintenance'), kind: 'VenueUnavailable', retryable: true },
  {
    name: 'ExchangeNotAvailable',
    err: new ExchangeNotAvailable('unavailable'),
    kind: 'VenueUnavailable',
    retryable: true,
  },
  { name: 'AuthenticationError', err: new AuthenticationError('bad key'), kind: 'AuthError', retryable: false },
  { name: 'PermissionDenied', err: new PermissionDenied('no perm'), kind: 'AuthError', retryable: false },
  { name: 'InsufficientFunds', err: new InsufficientFunds('no margin'), kind: 'InsufficientBalance', retryable: false },
  { name: 'OrderNotFound', err: new OrderNotFound('order missing'), kind: 'NotFound', retryable: false },
  { name: 'InvalidOrder', err: new InvalidOrder('bad order'), kind: 'OrderRejected', retryable: false },
]

/** Bybit v5 `retCode`s → expected kind (`error-map.ts` table). */
const CODE_CASES: ReadonlyArray<{ code: number; kind: VenueErrorKind; retryable: boolean }> = [
  { code: 403, kind: 'RateLimited', retryable: true },
  { code: 429, kind: 'RateLimited', retryable: true },
  { code: 10006, kind: 'RateLimited', retryable: true },
  { code: 10018, kind: 'RateLimited', retryable: true },
  { code: 10403, kind: 'RateLimited', retryable: true },
  { code: 10429, kind: 'RateLimited', retryable: true },
  { code: 10002, kind: 'AuthError', retryable: false },
  { code: 10003, kind: 'AuthError', retryable: false },
  { code: 10004, kind: 'AuthError', retryable: false },
  { code: 10005, kind: 'AuthError', retryable: false },
  { code: 10007, kind: 'InsufficientBalance', retryable: false },
  { code: 110007, kind: 'InsufficientBalance', retryable: false },
  { code: 110012, kind: 'InsufficientBalance', retryable: false },
  { code: 110045, kind: 'InsufficientBalance', retryable: false },
  { code: 110001, kind: 'NotFound', retryable: false },
  { code: 10001, kind: 'OrderRejected', retryable: false },
  { code: 110017, kind: 'OrderRejected', retryable: false },
  { code: 110043, kind: 'OrderRejected', retryable: false },
  { code: 110094, kind: 'OrderRejected', retryable: false },
  { code: 10015, kind: 'VenueUnavailable', retryable: true },
  { code: 10016, kind: 'VenueUnavailable', retryable: true },
]

describe('mapBybitError (10 §5)', () => {
  for (const c of CLASS_CASES) {
    it(`maps ccxt ${c.name} → ${c.kind}`, () => {
      const mapped = mapBybitError(c.err)
      expect(mapped).toBeInstanceOf(AdapterError)
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
    })
  }

  for (const c of CODE_CASES) {
    it(`maps Bybit retCode ${c.code} → ${c.kind}`, () => {
      const mapped = mapBybitError(Object.assign(new ExchangeError('x'), { code: c.code }))
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
      expect(mapped.rawCode).toBe(c.code)
    })
  }

  it('reads a retCode off a raw native response body (the lib throws the body, not an Error)', () => {
    const mapped = mapBybitError({ retCode: 110007, retMsg: 'ab not enough for new order' })
    expect(mapped.kind).toBe('InsufficientBalance')
    expect(mapped.rawCode).toBe(110007)
  })

  it('reads a retCode embedded in a ccxt message JSON blob', () => {
    const mapped = mapBybitError(new ExchangeError('bybit {"retCode":110001,"retMsg":"order not exists"}'))
    expect(mapped.kind).toBe('NotFound')
    expect(mapped.rawCode).toBe(110001)
  })

  it('numeric code wins over the ccxt class default', () => {
    // An InvalidOrder (class → OrderRejected) carrying 110001 in its message → NotFound.
    const mapped = mapBybitError(new InvalidOrder('bybit order does not exist 110001'))
    expect(mapped.kind).toBe('NotFound')
  })

  it('captures reason text on order rejections', () => {
    const mapped = mapBybitError(Object.assign(new ExchangeError('reduce-only rule not satisfied'), { code: 110017 }))
    expect(mapped.kind).toBe('OrderRejected')
    expect(mapped.reason).toBe('reduce-only rule not satisfied')
  })

  it('unknown code → NetworkError, onUnknown fired with the raw code, never a raw throw', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapBybitError(Object.assign(new ExchangeError('weird'), { code: 999999 }), {
      onUnknown: (raw) => {
        seen = raw
      },
    })
    expect(mapped).toBeInstanceOf(AdapterError)
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.retryable).toBe(true)
    expect(mapped.rawCode).toBe(999999)
    expect(seen).toBe(999999)
  })

  it('a plain non-ccxt error still maps (NetworkError, onUnknown with undefined code)', () => {
    let fired = false
    let rawSeen: string | number | undefined = 0
    const mapped = mapBybitError(new Error('boom'), {
      onUnknown: (raw) => {
        fired = true
        rawSeen = raw
      },
    })
    expect(mapped.kind).toBe('NetworkError')
    expect(fired).toBe(true)
    expect(rawSeen).toBeUndefined()
  })

  it('is idempotent — an already-mapped AdapterError passes through unwrapped', () => {
    const once = mapBybitError(new OrderNotFound('order missing'))
    expect(mapBybitError(once)).toBe(once)
  })
})
