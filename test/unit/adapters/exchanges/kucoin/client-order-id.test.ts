/**
 * Unit: the KuCoin `clientOrderId` ↔ `clientOid` mapping — a **length guard, not a codec**.
 *
 * The OKX sibling (`../okx/client-order-id.test.ts`) tests an escape codec because OKX's `clOrdId`
 * is alphanumeric-only; the Bitget one tests a ceiling *below* the core's. KuCoin is neither:
 * `clientOid` is documented as any unique string of at most **40** characters, and the engine's
 * key (`` `${intentId}-${leg}-${attempt}` ``, charset `[A-Za-z0-9_-]`, capped at 36) is a strict
 * subset. So the id travels verbatim in both directions and there is nothing to encode.
 *
 * The question the file exists to settle is the venue's UUID convention. KuCoin's docs put a
 * `str(uuid.uuid4())` in every worked example; if that were a *constraint* the engine id could not
 * travel verbatim, and the adapter would need a submit-time `clientOrderId → uuid` map — an
 * in-memory idempotency key, exactly what `11` §4 forbids (a crash between submit and ack loses
 * the mapping and a retry places a **second live order** under a fresh uuid). It is a convention:
 * the assertions below are what pins that, so a future "make it a UUID like the docs" edit fails
 * here rather than in production.
 *
 * The one real failure mode left is length, and it stays fail-loud (`10` §4): an over-long id must
 * never be truncated to fit, because a truncated key is not idempotent — a retry re-derives the
 * untruncated id, the adoption lookup misses, and the venue accepts a second live order for the
 * same leg. Hence throw on the way out, and drop-don't-guess on the way in.
 */

import { describe, expect, it } from 'vitest'
import {
  fromVenueClientOid,
  KUCOIN_MAX_CLIENT_OID_LEN,
  toVenueClientOid,
} from '../../../../../src/adapters/exchanges/kucoin/client-order-id.js'
import { MAX_CLIENT_ORDER_ID_LEN, makeClientOrderId } from '../../../../../src/core/order-id/client-order-id.js'

describe('toVenueClientOid', () => {
  it('sends a real engine id verbatim — no uuid, no codec, no rewriting of any kind', () => {
    expect(toVenueClientOid('BTC-28710000-entry-1')).toBe('BTC-28710000-entry-1')
  })

  it('passes the underscore and the digit-leading canonical names through unchanged', () => {
    expect(toVenueClientOid('A_B')).toBe('A_B')
    expect(toVenueClientOid('1INCH-28710000-exit-2')).toBe('1INCH-28710000-exit-2')
  })

  it('is the identity over every id the engine can build (11 §4 determinism)', () => {
    const ids = [
      makeClientOrderId({ intentId: 'BTC-28710000', leg: 'entry', attempt: 1 }),
      makeClientOrderId({ intentId: 'BONK-28710000', leg: 'exit', attempt: 3 }),
      makeClientOrderId({ intentId: '1INCH-28710000', leg: 'preabort', attempt: 2 }),
      makeClientOrderId({ intentId: 'XTZ-28710000', leg: 'protect', attempt: 1 }),
    ]
    for (const id of ids) expect(toVenueClientOid(id)).toBe(id)
  })

  it('has headroom the engine can never spend — the venue ceiling is ABOVE the core cap', () => {
    // 40 > 36, the mirror image of Bitget's 32 < 36. The longest id the core will ever produce
    // (a full epoch-ms intentId plus the longest leg) is still four chars inside the venue bound,
    // so the guard below should never fire in production.
    expect(KUCOIN_MAX_CLIENT_OID_LEN).toBeGreaterThan(MAX_CLIENT_ORDER_ID_LEN)
    const longest = makeClientOrderId({ intentId: '1000000MOG-1785081600000', leg: 'preabort', attempt: 1 })
    expect(longest).toHaveLength(35)
    expect(toVenueClientOid(longest)).toBe(longest)
  })

  it('accepts an id exactly at the venue ceiling', () => {
    const atLimit = 'A'.repeat(KUCOIN_MAX_CLIENT_OID_LEN)
    expect(toVenueClientOid(atLimit)).toBe(atLimit)
  })

  it('fails loud rather than truncating one char past the ceiling (a truncated key is not idempotent)', () => {
    const overLimit = 'A'.repeat(KUCOIN_MAX_CLIENT_OID_LEN + 1)
    // The point of the throw: it must not come back as a shortened but *valid-looking* id, which
    // a retry would never re-derive — so this is a throw, not a truncation to the ceiling.
    expect(() => toVenueClientOid(overLimit)).toThrow(/is 41 chars, outside 1\.\.40/)
  })

  it('fails loud on the empty id rather than sending an unkeyed order', () => {
    expect(() => toVenueClientOid('')).toThrow(/outside 1\.\.40/)
  })

  it('fails loud on a character outside the engine charset (never send a doomed order)', () => {
    expect(() => toVenueClientOid('BTC 1')).toThrow(/outside the engine charset/)
    expect(() => toVenueClientOid('BTC#1')).toThrow(/outside the engine charset/)
  })
})

describe('fromVenueClientOid', () => {
  it('round-trips a real makeClientOrderId output through the venue and back', () => {
    const ids = [
      makeClientOrderId({ intentId: 'BTC-28710000', leg: 'entry', attempt: 1 }),
      makeClientOrderId({ intentId: 'BONK-28710000', leg: 'exit', attempt: 3 }),
      makeClientOrderId({ intentId: '1000000MOG-1785081600000', leg: 'preabort', attempt: 1 }),
    ]
    for (const id of ids) expect(fromVenueClientOid(toVenueClientOid(id))).toBe(id)
  })

  it('drops an echo this engine could not have produced rather than guessing', () => {
    expect(fromVenueClientOid('')).toBeUndefined() // the venue sends "" when no clientOid was set
    expect(fromVenueClientOid('A'.repeat(KUCOIN_MAX_CLIENT_OID_LEN + 1))).toBeUndefined()
    expect(fromVenueClientOid('BTC 1')).toBeUndefined()
    expect(fromVenueClientOid('not*our*charset')).toBeUndefined()
  })

  it('passes a foreign but well-formed key through unchanged (someone else’s order id)', () => {
    // It is a shape filter, not an ownership check: a uuid from another client on the same account
    // is inside this charset and decodes to itself, and the engine's intent lookup drops it.
    expect(fromVenueClientOid('someOtherBot001')).toBe('someOtherBot001')
    expect(fromVenueClientOid('7a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d')).toBe('7a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d')
  })
})
