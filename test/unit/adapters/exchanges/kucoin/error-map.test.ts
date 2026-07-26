/**
 * Unit: KuCoin venue-error mapping (`10` §5). Same shape as the four siblings — ccxt class cases,
 * venue-code cases, code-wins-over-class, unknown → retryable `NetworkError` with `onUnknown`
 * fired, idempotency — because the union the core sees is shared (task 0200 decision 5) and only
 * the table differs.
 *
 * What is genuinely KuCoin-specific, and why this file is not a copy of the Bitget sibling:
 *  - **one success envelope, `"200000"`, on both surfaces.** Bitget answers `"00000"` on REST and
 *    `"0"` on its WS trade API; KuCoin answers `200000` everywhere. `200000` is a perfectly
 *    well-formed 6-digit code, so nothing but the envelope set stops it being looked up — and a
 *    frame carrying it must fall through to unknown rather than mapping to a kind.
 *  - **three arrival shapes, one table.** The native SDK throws
 *    `{code: <HTTP status>, message, body: {code: '<venue>', msg}}` (the venue code is *nested*,
 *    and the top level is the HTTP status — reading it first classifies every rejection as the
 *    status); the WS trade API rejects with a **flat** `{code, op, msg}` frame whose code space
 *    overlaps REST's; and ccxt embeds the whole envelope in its message text. All three must land
 *    on the same kind, or the same venue failure would be typed differently per transport.
 *  - codes are **strings** of 4–6 digits and stay strings on the mapped error, as on Bitget.
 */

import { ExchangeError, InvalidOrder, OrderNotFound, RateLimitExceeded, RequestTimeout } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { mapKucoinError } from '../../../../../src/adapters/exchanges/kucoin/error-map.js'
import { AdapterError } from '../../../../../src/adapters/shared/errors.js'
import type { VenueErrorKind } from '../../../../../src/core/ports/exchange-adapter.js'

/** ccxt class instances → expected kind (message carries no numeric code). */
const CLASS_CASES: ReadonlyArray<{ name: string; err: Error; kind: VenueErrorKind; retryable: boolean }> = [
  { name: 'RateLimitExceeded', err: new RateLimitExceeded('rate limited'), kind: 'RateLimited', retryable: true },
  { name: 'RequestTimeout', err: new RequestTimeout('timed out'), kind: 'NetworkError', retryable: true },
  { name: 'OrderNotFound', err: new OrderNotFound('order missing'), kind: 'NotFound', retryable: false },
  { name: 'InvalidOrder', err: new InvalidOrder('bad order'), kind: 'OrderRejected', retryable: false },
]

/** Representative KuCoin codes → expected kind (`error-map.ts` table); strings, as on the wire. */
const CODE_CASES: ReadonlyArray<{ code: string; kind: VenueErrorKind; retryable: boolean }> = [
  { code: '429', kind: 'RateLimited', retryable: true }, // HTTP edge, before any venue code exists
  { code: '429000', kind: 'RateLimited', retryable: true }, // the resource-pool quota, 30 s window
  { code: '400006', kind: 'AuthError', retryable: false }, // IP not allowlisted — seen live, task 0460
  { code: '400004', kind: 'AuthError', retryable: false }, // passphrase error — the third credential
  { code: '100004', kind: 'NotFound', retryable: false }, // order gone / never existed
  { code: '300003', kind: 'InsufficientBalance', retryable: false }, // balance not enough to place
  { code: '300000', kind: 'OrderRejected', retryable: false }, // request parameter illegal
  { code: '400100', kind: 'OrderRejected', retryable: false }, // parameter error
  { code: '500000', kind: 'VenueUnavailable', retryable: true }, // internal server error
]

describe('mapKucoinError (10 §5)', () => {
  for (const c of CLASS_CASES) {
    it(`maps ccxt ${c.name} → ${c.kind}`, () => {
      const mapped = mapKucoinError(c.err)
      expect(mapped).toBeInstanceOf(AdapterError)
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
    })
  }

  for (const c of CODE_CASES) {
    it(`maps KuCoin code ${c.code} → ${c.kind}`, () => {
      const mapped = mapKucoinError(Object.assign(new ExchangeError('x'), { code: c.code }))
      expect(mapped.kind).toBe(c.kind)
      expect(mapped.retryable).toBe(c.retryable)
      // Stays a string end to end — the table is keyed by what the wire spells.
      expect(mapped.rawCode).toBe(c.code)
    })
  }

  it('accepts a numeric code off the wire but still resolves it as its string form', () => {
    // Some transports hand back `429` as a number; the lookup key must not care.
    const mapped = mapKucoinError({ code: 429, msg: 'Too Many Requests' })
    expect(mapped.kind).toBe('RateLimited')
    expect(mapped.rawCode).toBe('429')
  })
})

/**
 * The three shapes a KuCoin failure arrives in. One venue failure must produce one kind whichever
 * transport reported it, so each shape is asserted against the same table rather than trusted to
 * "look similar enough".
 */
describe('mapKucoinError — the three arrival shapes', () => {
  it('shape 1 (native REST throw): reads body.code, never the HTTP status at the top level', () => {
    // Confirmed live against this repo's keys (task 0460): an IP-allowlist rejection arrives as
    // `403` + `body.code: '400006'`. Reading the top-level `code` would classify every REST
    // rejection as one unknown retryable NetworkError.
    const mapped = mapKucoinError({
      code: 403,
      message: 'Forbidden',
      body: { code: '400006', msg: 'The requesting IP is not in the API key whitelist' },
    })
    expect(mapped.kind).toBe('AuthError')
    expect(mapped.rawCode).toBe('400006')
    expect(mapped.reason).toBe('The requesting IP is not in the API key whitelist')
    // The native SDK throws a plain object, so `String(err)` would have been `[object Object]`.
    expect(mapped.message).toBe('The requesting IP is not in the API key whitelist')
  })

  it('shape 2 (flat WS-API reject frame): the same table serves the overlapping WS code space', () => {
    const mapped = mapKucoinError({ code: '429000', op: 'futures.order', msg: 'Too many requests' })
    expect(mapped.kind).toBe('RateLimited')
    expect(mapped.rawCode).toBe('429000')
    expect(mapped.reason).toBe('Too many requests')
  })

  it('shape 3 (ccxt error): lifts the code out of the JSON blob embedded in the message', () => {
    const mapped = mapKucoinError(new ExchangeError('kucoinfutures {"code":"300003","msg":"Balance not enough"}'))
    expect(mapped.kind).toBe('InsufficientBalance')
    expect(mapped.rawCode).toBe('300003')
  })

  it('all three shapes of one venue failure land on the same kind', () => {
    const nested = mapKucoinError({ code: 400, message: 'Bad Request', body: { code: '100004', msg: 'gone' } })
    const flat = mapKucoinError({ code: '100004', op: 'futures.cancel', msg: 'gone' })
    const ccxtish = mapKucoinError(new ExchangeError('kucoinfutures {"code":"100004","msg":"gone"}'))
    for (const mapped of [nested, flat, ccxtish]) {
      expect(mapped.kind).toBe('NotFound')
      expect(mapped.rawCode).toBe('100004')
    }
  })
})

describe('mapKucoinError — the 200000 success envelope', () => {
  it('never reads "200000" as an error code, on REST or on the WS trade API', () => {
    // Unlike Bitget's `"00000"`/`"0"`, this is a well-formed 6-digit code: only the envelope set
    // stops it being looked up, so a frame carrying it must fall through to unknown.
    let seen: string | number | undefined = 'unset'
    const mapped = mapKucoinError({ code: '200000', msg: 'success' }, { onUnknown: (raw) => (seen = raw) })
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.rawCode).toBeUndefined()
    expect(seen).toBeUndefined()
  })

  it('ignores it on the WS trade API too — one envelope value serves both surfaces', () => {
    // Bitget needs two entries here (`"00000"` REST, `"0"` WS); KuCoin answers `200000` on both,
    // so a WS-shaped frame carrying it must fall through exactly like the REST one.
    let seen: string | number | undefined = 'unset'
    const mapped = mapKucoinError(
      { code: '200000', op: 'futures.order', msg: 'success' },
      { onUnknown: (raw) => (seen = raw) },
    )
    expect(mapped.rawCode).toBeUndefined()
    expect(seen).toBeUndefined()
  })
})

describe('mapKucoinError — order-not-found is a message, not a code (verified live, task 0460)', () => {
  // The live read-only tier caught this: reading an order this account never placed answers
  // HTTP **200** with `{ code: '100001', msg: 'error.getOrder.orderNotExist' }` — the venue's
  // *generic* "invalid parameters" code. There is no dedicated not-found code, so the message
  // key is the only discriminator, and it must beat the code table.
  const shapes = [
    {
      name: 'native throw (HTTP 200!)',
      err: { code: 200, message: 'OK', body: { code: '100001', msg: 'error.getOrder.orderNotExist' } },
    },
    {
      name: 'flat WS-API frame',
      err: { code: '100001', op: 'futures.cancel', msg: 'error.cancelOrder.orderNotExist' },
    },
    {
      name: 'ccxt message blob',
      err: new ExchangeError('kucoinfutures {"msg":"error.getOrder.orderNotExist","code":"100001"}'),
    },
  ] as const

  for (const { name, err } of shapes) {
    it(`maps 100001 + orderNotExist to NotFound — ${name}`, () => {
      expect(mapKucoinError(err).kind).toBe('NotFound')
    })
  }

  it('still maps a *genuine* 100001 parameter error to OrderRejected', () => {
    // This is why the code is not simply tabled as NotFound: `11` §6 treats a not-found cancel as
    // "already gone, reconcile to truth", so tabling it would silently swallow real rejections.
    const mapped = mapKucoinError({ code: 200, body: { code: '100001', msg: 'There are invalid parameters' } })
    expect(mapped.kind).toBe('OrderRejected')
    expect(mapped.rawCode).toBe('100001')
  })
})

describe('mapKucoinError — resolution order', () => {
  it('venue code wins over the ccxt class default', () => {
    // An InvalidOrder (class → OrderRejected) whose text carries 100004 → NotFound instead.
    expect(mapKucoinError(new InvalidOrder('kucoin order does not exist 100004')).kind).toBe('NotFound')
  })

  it('falls back to the ccxt class most-specific-first — OrderNotFound before its InvalidOrder parent', () => {
    // `OrderNotFound extends InvalidOrder`, so a parent-first test would type every not-found as a
    // rejection and the manager would stop reconciling a gone order to truth (`11` §6).
    expect(new OrderNotFound('x')).toBeInstanceOf(InvalidOrder)
    expect(mapKucoinError(new OrderNotFound('order missing')).kind).toBe('NotFound')
    expect(mapKucoinError(new InvalidOrder('bad order')).kind).toBe('OrderRejected')
  })

  it("carries KuCoin's `msg` through as `reason` (the order FSM's reject text)", () => {
    const mapped = mapKucoinError(
      Object.assign(new ExchangeError('request failed'), { code: '300003', msg: 'Balance not enough' }),
    )
    expect(mapped.kind).toBe('InsufficientBalance')
    expect(mapped.reason).toBe('Balance not enough')
  })

  it('falls back to the message text as `reason` when the venue ships no `msg`', () => {
    const mapped = mapKucoinError(Object.assign(new ExchangeError('request parameter illegal'), { code: '300000' }))
    expect(mapped.reason).toBe('request parameter illegal')
  })

  it('unknown code → NetworkError, onUnknown fired with the raw code, never a raw throw', () => {
    let seen: string | number | undefined = 'unset'
    const mapped = mapKucoinError(Object.assign(new ExchangeError('weird'), { code: '999999' }), {
      onUnknown: (raw) => {
        seen = raw
      },
    })
    expect(mapped).toBeInstanceOf(AdapterError)
    expect(mapped.kind).toBe('NetworkError')
    expect(mapped.retryable).toBe(true) // an unlisted code stays retryable rather than being guessed
    expect(mapped.rawCode).toBe('999999')
    expect(seen).toBe('999999')
  })

  it('a plain non-ccxt error still maps (NetworkError, onUnknown with undefined code)', () => {
    let fired = false
    let rawSeen: string | number | undefined = 0
    const mapped = mapKucoinError(new Error('boom'), {
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
    const once = mapKucoinError(new OrderNotFound('order missing'))
    expect(mapKucoinError(once)).toBe(once)
  })
})
