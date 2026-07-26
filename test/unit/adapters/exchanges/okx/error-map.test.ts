/**
 * Unit: OKX venue-error mapping (`10` §5). Mirrors the Bybit sibling's structure — ccxt class
 * cases, venue-code cases, code-wins-over-class, unknown → retryable `NetworkError` with
 * `onUnknown` fired, idempotency. The OKX-specific cases are the code shapes: a **string**
 * code, the `code: '1'` envelope whose real reason hides at `data[0].sCode`/`sMsg`, and the
 * `'0'`/`'1'` envelope values that must never be read as error codes.
 */

import { ExchangeError, InvalidOrder, OrderNotFound, RateLimitExceeded, RequestTimeout } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { mapOkxError } from '../../../../../src/adapters/exchanges/okx/error-map.js'
import { AdapterError } from '../../../../../src/adapters/shared/errors.js'
import type { VenueErrorKind } from '../../../../../src/core/ports/exchange-adapter.js'

/** ccxt class instances → expected kind (message carries no numeric code). */
const CLASS_CASES: ReadonlyArray<{ name: string; err: Error; kind: VenueErrorKind; retryable: boolean }> = [
  { name: 'RateLimitExceeded', err: new RateLimitExceeded('rate limited'), kind: 'RateLimited', retryable: true },
  { name: 'RequestTimeout', err: new RequestTimeout('timed out'), kind: 'NetworkError', retryable: true },
  { name: 'OrderNotFound', err: new OrderNotFound('order missing'), kind: 'NotFound', retryable: false },
  { name: 'InvalidOrder', err: new InvalidOrder('bad order'), kind: 'OrderRejected', retryable: false },
]

/** OKX v5 codes → expected kind (`error-map.ts` table). */
const CODE_CASES: ReadonlyArray<{ code: number; kind: VenueErrorKind; retryable: boolean }> = [
  { code: 429, kind: 'RateLimited', retryable: true },
  { code: 50011, kind: 'RateLimited', retryable: true },
  { code: 50061, kind: 'RateLimited', retryable: true },
  { code: 60014, kind: 'RateLimited', retryable: true },
  { code: 50004, kind: 'NetworkError', retryable: true },
  { code: 50001, kind: 'VenueUnavailable', retryable: true },
  { code: 50013, kind: 'VenueUnavailable', retryable: true },
  { code: 63999, kind: 'VenueUnavailable', retryable: true },
  { code: 50102, kind: 'AuthError', retryable: false },
  { code: 50104, kind: 'AuthError', retryable: false },
  { code: 50105, kind: 'AuthError', retryable: false },
  { code: 50113, kind: 'AuthError', retryable: false },
  { code: 60007, kind: 'AuthError', retryable: false },
  { code: 51008, kind: 'InsufficientBalance', retryable: false },
  { code: 51127, kind: 'InsufficientBalance', retryable: false },
  { code: 51131, kind: 'InsufficientBalance', retryable: false },
  { code: 51001, kind: 'NotFound', retryable: false },
  { code: 51400, kind: 'NotFound', retryable: false },
  { code: 51603, kind: 'NotFound', retryable: false },
  { code: 51000, kind: 'OrderRejected', retryable: false },
  { code: 51006, kind: 'OrderRejected', retryable: false },
  { code: 51020, kind: 'OrderRejected', retryable: false },
  { code: 51121, kind: 'OrderRejected', retryable: false },
  { code: 59000, kind: 'OrderRejected', retryable: false },
]

describe('mapOkxError (10 §5)', () => {
  for (const c of CLASS_CASES) {
    it(`maps ccxt ${c.name} → ${c.kind}`, () => {
      const mapped = mapOkxError(c.err)
      expect(mapped).toBeInstanceOf(AdapterError)
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
    })
  }

  for (const c of CODE_CASES) {
    it(`maps OKX code ${c.code} → ${c.kind}`, () => {
      // On the wire every OKX code is a string — that is the shape under test.
      const mapped = mapOkxError(Object.assign(new ExchangeError('x'), { code: String(c.code) }))
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
      expect(mapped.rawCode).toBe(c.code)
    })
  }

  it("lifts the per-order reject shape: code '1' envelope, real reason at data[0].sCode/sMsg", () => {
    const mapped = mapOkxError({
      code: '1',
      msg: 'All operations failed',
      data: [{ sCode: '51008', sMsg: 'Order placement failed due to insufficient balance', clOrdId: 'x', ordId: '' }],
    })
    expect(mapped.kind).toBe('InsufficientBalance')
    expect(mapped.rawCode).toBe(51008)
    expect(mapped.reason).toBe('Order placement failed due to insufficient balance')
  })

  it("never reads the '0'/'1' envelope values as error codes", () => {
    // A bare `code: '1'` with no nested reason is not code 1 — it falls through to unknown.
    let seen: string | number | undefined = 'unset'
    const mapped = mapOkxError({ code: '1', msg: 'operation failed' }, { onUnknown: (raw) => (seen = raw) })
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.rawCode).toBeUndefined()
    expect(seen).toBeUndefined()
  })

  it('reads a code off a raw native response body (the lib throws the body, not an Error)', () => {
    const mapped = mapOkxError({ code: '50011', msg: 'Too Many Requests' })
    expect(mapped.kind).toBe('RateLimited')
    expect(mapped.rawCode).toBe(50011)
    expect(mapped.reason).toBe('Too Many Requests')
  })

  it('reads a code embedded in a ccxt message JSON blob', () => {
    const mapped = mapOkxError(new ExchangeError('okx {"code":"51603","msg":"Order does not exist"}'))
    expect(mapped.kind).toBe('NotFound')
    expect(mapped.rawCode).toBe(51603)
  })

  it('venue code wins over the ccxt class default', () => {
    // An InvalidOrder (class → OrderRejected) carrying 51603 in its message → NotFound.
    const mapped = mapOkxError(new InvalidOrder('okx order does not exist 51603'))
    expect(mapped.kind).toBe('NotFound')
  })

  it('captures reason text on order rejections', () => {
    const mapped = mapOkxError(
      Object.assign(new ExchangeError('Order amount is not a multiple of the lot size'), { code: '51121' }),
    )
    expect(mapped.kind).toBe('OrderRejected')
    expect(mapped.reason).toBe('Order amount is not a multiple of the lot size')
  })

  it('unknown code → NetworkError, onUnknown fired with the raw code, never a raw throw', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapOkxError(Object.assign(new ExchangeError('weird'), { code: '59999' }), {
      onUnknown: (raw) => {
        seen = raw
      },
    })
    expect(mapped).toBeInstanceOf(AdapterError)
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.retryable).toBe(true)
    expect(mapped.rawCode).toBe(59999)
    expect(seen).toBe(59999)
  })

  it('a plain non-ccxt error still maps (NetworkError, onUnknown with undefined code)', () => {
    let fired = false
    let rawSeen: string | number | undefined = 0
    const mapped = mapOkxError(new Error('boom'), {
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
    const once = mapOkxError(new OrderNotFound('order missing'))
    expect(mapOkxError(once)).toBe(once)
  })
})
