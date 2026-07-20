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
import { mapBinanceError } from '../../../../../src/adapters/exchanges/binance/error-map.js'
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

/** Binance numeric codes → expected kind (`10` §5 table). */
const CODE_CASES: ReadonlyArray<{ code: number; kind: VenueErrorKind; retryable: boolean }> = [
  { code: 429, kind: 'RateLimited', retryable: true },
  { code: 418, kind: 'RateLimited', retryable: true },
  { code: -1003, kind: 'RateLimited', retryable: true },
  { code: -2010, kind: 'OrderRejected', retryable: false },
  { code: -1013, kind: 'OrderRejected', retryable: false },
  { code: -1111, kind: 'OrderRejected', retryable: false },
  { code: -4164, kind: 'OrderRejected', retryable: false },
  { code: -2021, kind: 'OrderRejected', retryable: false },
  { code: -2022, kind: 'OrderRejected', retryable: false },
  { code: -2019, kind: 'InsufficientBalance', retryable: false },
  { code: -2013, kind: 'NotFound', retryable: false },
  { code: -2015, kind: 'AuthError', retryable: false },
  { code: -1021, kind: 'AuthError', retryable: false },
  { code: -1022, kind: 'AuthError', retryable: false },
  { code: -1000, kind: 'VenueUnavailable', retryable: true },
  { code: -1001, kind: 'VenueUnavailable', retryable: true },
  { code: -1016, kind: 'VenueUnavailable', retryable: true },
]

describe('mapBinanceError (10 §5)', () => {
  for (const c of CLASS_CASES) {
    it(`maps ccxt ${c.name} → ${c.kind}`, () => {
      const mapped = mapBinanceError(c.err)
      expect(mapped).toBeInstanceOf(AdapterError)
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
    })
  }

  for (const c of CODE_CASES) {
    it(`maps Binance code ${c.code} → ${c.kind}`, () => {
      const mapped = mapBinanceError(Object.assign(new ExchangeError('x'), { code: c.code }))
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
      expect(mapped.rawCode).toBe(c.code)
    })
  }

  it('numeric code wins over the ccxt class default', () => {
    // An InvalidOrder (class → OrderRejected) carrying -2013 in its message → NotFound.
    const mapped = mapBinanceError(new InvalidOrder('binance order does not exist -2013'))
    expect(mapped.kind).toBe('NotFound')
  })

  it('captures reason text on order rejections', () => {
    const mapped = mapBinanceError(Object.assign(new ExchangeError('MIN_NOTIONAL not met'), { code: -2010 }))
    expect(mapped.kind).toBe('OrderRejected')
    expect(mapped.reason).toBe('MIN_NOTIONAL not met')
  })

  it('unknown code → NetworkError, onUnknown fired with the raw code, never a raw throw', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapBinanceError(Object.assign(new ExchangeError('weird'), { code: -9999 }), {
      onUnknown: (raw) => {
        seen = raw
      },
    })
    expect(mapped).toBeInstanceOf(AdapterError)
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.retryable).toBe(true)
    expect(mapped.rawCode).toBe(-9999)
    expect(seen).toBe(-9999)
  })

  it('a plain non-ccxt error still maps (NetworkError, onUnknown with undefined code)', () => {
    let fired = false
    let rawSeen: string | number | undefined = 0
    const mapped = mapBinanceError(new Error('boom'), {
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
    const once = mapBinanceError(new OrderNotFound('order missing'))
    expect(mapBinanceError(once)).toBe(once)
  })
})
