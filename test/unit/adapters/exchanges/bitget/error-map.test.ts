/**
 * Unit: Bitget venue-error mapping (`10` §5). Same shape as the OKX/Bybit siblings — ccxt class
 * cases, venue-code cases, code-wins-over-class, unknown → retryable `NetworkError` with
 * `onUnknown` fired, idempotency — because the union the core sees is shared (task 0200
 * decision 5) and only the table differs.
 *
 * What is genuinely Bitget-specific, and why these tests exist rather than being a copy:
 *  - **codes are strings all the way through.** The table is keyed by the string the wire
 *    spells, not a parsed number, because this venue's REST success envelope is `"00000"` —
 *    parsed numerically it collapses onto `0` and would start colliding with real codes. So
 *    `rawCode` is asserted as a *string* here, unlike OKX where it is normalized to a number.
 *  - **there are two success envelopes, not one.** REST answers `"00000"`, the WS trade API
 *    answers `"0"` (`./ws-orders.ts`). Neither may ever be looked up as an error code; a frame
 *    carrying one and nothing else must fall through to unknown rather than mapping to a kind.
 */

import { ExchangeError, InvalidOrder, OrderNotFound, RateLimitExceeded, RequestTimeout } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { mapBitgetError } from '../../../../../src/adapters/exchanges/bitget/error-map.js'
import { AdapterError } from '../../../../../src/adapters/shared/errors.js'
import type { VenueErrorKind } from '../../../../../src/core/ports/exchange-adapter.js'

/** ccxt class instances → expected kind (message carries no numeric code). */
const CLASS_CASES: ReadonlyArray<{ name: string; err: Error; kind: VenueErrorKind; retryable: boolean }> = [
  { name: 'RateLimitExceeded', err: new RateLimitExceeded('rate limited'), kind: 'RateLimited', retryable: true },
  { name: 'RequestTimeout', err: new RequestTimeout('timed out'), kind: 'NetworkError', retryable: true },
  { name: 'OrderNotFound', err: new OrderNotFound('order missing'), kind: 'NotFound', retryable: false },
  { name: 'InvalidOrder', err: new InvalidOrder('bad order'), kind: 'OrderRejected', retryable: false },
]

/** Representative Bitget codes → expected kind (`error-map.ts` table); strings, as on the wire. */
const CODE_CASES: ReadonlyArray<{ code: string; kind: VenueErrorKind; retryable: boolean }> = [
  { code: '429', kind: 'RateLimited', retryable: true }, // HTTP edge, before any venue code exists
  { code: '30001', kind: 'RateLimited', retryable: true }, // WS: request too frequent
  { code: '40010', kind: 'NetworkError', retryable: true }, // timed out — order status unknown
  { code: '40200', kind: 'VenueUnavailable', retryable: true },
  { code: '40009', kind: 'AuthError', retryable: false }, // signature error
  { code: '40011', kind: 'AuthError', retryable: false }, // passphrase empty — the third credential
  { code: '40014', kind: 'AuthError', retryable: false }, // key lacks the trade permission
  { code: '43012', kind: 'InsufficientBalance', retryable: false },
  { code: '40768', kind: 'NotFound', retryable: false }, // order does not exist
  { code: '22001', kind: 'NotFound', retryable: false }, // no order to cancel
  { code: '40762', kind: 'OrderRejected', retryable: false }, // over the max open size
  { code: '45110', kind: 'OrderRejected', retryable: false }, // below min notional
  { code: '40017', kind: 'OrderRejected', retryable: false }, // parameter verification failed
]

describe('mapBitgetError (10 §5)', () => {
  for (const c of CLASS_CASES) {
    it(`maps ccxt ${c.name} → ${c.kind}`, () => {
      const mapped = mapBitgetError(c.err)
      expect(mapped).toBeInstanceOf(AdapterError)
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
    })
  }

  for (const c of CODE_CASES) {
    it(`maps Bitget code ${c.code} → ${c.kind}`, () => {
      const mapped = mapBitgetError(Object.assign(new ExchangeError('x'), { code: c.code }))
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
      // Stays a string end to end — the whole reason the table is not keyed numerically.
      expect(mapped.rawCode).toBe(c.code)
    })
  }

  it('accepts a numeric code off the wire but still resolves it as its string form', () => {
    // Some transports hand back `429` as a number; the lookup key must not care.
    const mapped = mapBitgetError({ code: 429, msg: 'Too Many Requests' })
    expect(mapped.kind).toBe('RateLimited')
    expect(mapped.rawCode).toBe('429')
  })

  it('never reads the REST success envelope "00000" as an error code', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapBitgetError({ code: '00000', msg: 'success' }, { onUnknown: (raw) => (seen = raw) })
    // Parsed numerically this would be `0`; as a string it is simply not a code at all.
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.rawCode).toBeUndefined()
    expect(seen).toBeUndefined()
  })

  it('never reads the WS trade API success envelope "0" as an error code either', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapBitgetError({ code: '0', msg: 'success' }, { onUnknown: (raw) => (seen = raw) })
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.rawCode).toBeUndefined()
    expect(seen).toBeUndefined()
  })

  it('reads a code off a raw native response body (the lib throws the body, not an Error)', () => {
    const mapped = mapBitgetError({ code: '43012', msg: 'Insufficient balance' })
    expect(mapped.kind).toBe('InsufficientBalance')
    expect(mapped.rawCode).toBe('43012')
    expect(mapped.reason).toBe('Insufficient balance')
  })

  /**
   * Regression, task 0440 Phase 2 (live demo): `RestClientV3` throws
   * `{code: 400, message: 'Bad Request', body: {code: '25204', msg: …}}` — the top-level `code`
   * is the **HTTP status**. Reading it first classified every REST rejection as one unknown
   * retryable `NetworkError`, so the nested envelope has to win.
   */
  it('reads the nested body.code, never the HTTP status the native lib puts at the top', () => {
    const mapped = mapBitgetError({
      code: 400,
      message: 'Bad Request',
      body: { code: '25204', msg: 'Order does not exist' },
    })
    expect(mapped.kind).toBe('NotFound')
    expect(mapped.rawCode).toBe('25204')
    expect(mapped.reason).toBe('Order does not exist')
    // The plain object is not an Error, so `String(err)` would have been `[object Object]`.
    expect(mapped.message).toBe('Order does not exist')
  })

  it('tables the WS trade API code space too — the same venue answers with different codes', () => {
    // A tick-grid violation is `43028` on the WS-API and `25244` on REST; both must classify.
    expect(mapBitgetError({ code: '43028', msg: 'Please enter an integer multiple of 0.1 for price' }).kind).toBe(
      'OrderRejected',
    )
    expect(mapBitgetError({ code: '25244', msg: 'Price should be multiple of 0.1' }).kind).toBe('OrderRejected')
    // Duplicate clientOid — the idempotency collision the order path depends on being typed.
    expect(mapBitgetError({ code: '50060', msg: 'Duplicated clientOid' }).kind).toBe('OrderRejected')
  })

  it('lifts a code out of a ccxt message JSON blob when the error object carries none', () => {
    const mapped = mapBitgetError(new ExchangeError('bitget {"code":"40768","msg":"The order does not exist"}'))
    expect(mapped.kind).toBe('NotFound')
    expect(mapped.rawCode).toBe('40768')
  })

  it('venue code wins over the ccxt class default', () => {
    // An InvalidOrder (class → OrderRejected) whose text carries 40768 → NotFound instead.
    const mapped = mapBitgetError(new InvalidOrder('bitget order does not exist 40768'))
    expect(mapped.kind).toBe('NotFound')
  })

  it("carries Bitget's `msg` through as `reason` (the order FSM's reject text)", () => {
    const mapped = mapBitgetError(
      Object.assign(new ExchangeError('request failed'), {
        code: '45110',
        msg: 'The order amount is lower than the minimum order value',
      }),
    )
    expect(mapped.kind).toBe('OrderRejected')
    expect(mapped.reason).toBe('The order amount is lower than the minimum order value')
  })

  it('falls back to the message text as `reason` when the venue ships no `msg`', () => {
    const mapped = mapBitgetError(Object.assign(new ExchangeError('parameter verification failed'), { code: '40017' }))
    expect(mapped.reason).toBe('parameter verification failed')
  })

  it('unknown code → NetworkError, onUnknown fired with the raw code, never a raw throw', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapBitgetError(Object.assign(new ExchangeError('weird'), { code: '49999' }), {
      onUnknown: (raw) => {
        seen = raw
      },
    })
    expect(mapped).toBeInstanceOf(AdapterError)
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.retryable).toBe(true) // an unlisted code is retryable until 0440 Phase 2 lists it
    expect(mapped.rawCode).toBe('49999')
    expect(seen).toBe('49999')
  })

  it('a plain non-ccxt error still maps (NetworkError, onUnknown with undefined code)', () => {
    let fired = false
    let rawSeen: string | number | undefined = 0
    const mapped = mapBitgetError(new Error('boom'), {
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
    const once = mapBitgetError(new OrderNotFound('order missing'))
    expect(mapBitgetError(once)).toBe(once)
  })
})
