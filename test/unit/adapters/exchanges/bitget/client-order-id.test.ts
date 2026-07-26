/**
 * Unit: the Bitget `clientOrderId` ↔ `clientOid` mapping — a **length guard, not a codec**.
 *
 * The OKX sibling (`../okx/client-order-id.test.ts`) tests an escape codec because OKX's
 * `clOrdId` is alphanumeric-only. Bitget documents `^[\.A-Z\:/a-z0-9_-]{1,32}$`, which is a
 * *superset* of the engine's `[A-Za-z0-9_-]` key — so the id travels verbatim in both
 * directions and there is nothing to encode. What is left is the one real mismatch: the engine
 * caps its key at 36 chars (`MAX_CLIENT_ORDER_ID_LEN`) and Bitget at **32**, so a legal engine
 * id can be illegal at the venue.
 *
 * That gap is the whole point of the file. Truncating to fit would break `11` §4 idempotency:
 * a retry re-derives the *untruncated* id, so the adoption lookup would miss and the venue
 * would accept a **second live order** for the same leg. Hence fail-loud on the way out
 * (`10` §4), and drop-don't-guess on the way in — an echo carrying an id this engine could not
 * have produced must never be routed into some other intent's FSM.
 */

import { describe, expect, it } from 'vitest'
import {
  BITGET_MAX_CLIENT_OID_LEN,
  fromVenueClientOid,
  toVenueClientOid,
} from '../../../../../src/adapters/exchanges/bitget/client-order-id.js'
import { makeClientOrderId } from '../../../../../src/core/order-id/client-order-id.js'

describe('toVenueClientOid', () => {
  it('sends a real engine id verbatim — hyphens are inside the Bitget charset', () => {
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

  it('accepts an id exactly at the venue ceiling', () => {
    const atLimit = 'A'.repeat(BITGET_MAX_CLIENT_OID_LEN)
    expect(toVenueClientOid(atLimit)).toBe(atLimit)
  })

  it('fails loud rather than truncating one char past the ceiling', () => {
    const overLimit = 'A'.repeat(BITGET_MAX_CLIENT_OID_LEN + 1)
    expect(() => toVenueClientOid(overLimit)).toThrow(/is 33 chars, over the 32 limit/)
  })

  it('fails loud on an engine id the core accepts but Bitget will not (36 vs 32)', () => {
    // A full epoch-ms intentId plus the longest leg: 35 chars — legal at the core's 36 cap,
    // four over Bitget's. This is the only shape of engine id the venue can reject.
    const id = makeClientOrderId({ intentId: '1000000MOG-1785081600000', leg: 'preabort', attempt: 1 })
    expect(id).toHaveLength(35)
    expect(() => toVenueClientOid(id)).toThrow(/over the 32 limit/)
  })

  it('fails loud on a character outside the venue charset (never send a doomed order)', () => {
    expect(() => toVenueClientOid('BTC 1')).toThrow(/outside the venue charset/)
    expect(() => toVenueClientOid('BTC#1')).toThrow(/outside the venue charset/)
  })

  it('allows the punctuation Bitget documents but the engine never emits', () => {
    // `.`, `:` and `/` are in the venue charset, so the guard must not reject them — the guard
    // exists to catch what the *venue* would reject, not to re-assert the core's own charset.
    expect(toVenueClientOid('BTC.1:2/3')).toBe('BTC.1:2/3')
  })
})

describe('fromVenueClientOid', () => {
  it('round-trips every id the engine can build', () => {
    const ids = [
      makeClientOrderId({ intentId: 'BTC-28710000', leg: 'entry', attempt: 1 }),
      makeClientOrderId({ intentId: 'BONK-28710000', leg: 'exit', attempt: 3 }),
    ]
    for (const id of ids) expect(fromVenueClientOid(toVenueClientOid(id))).toBe(id)
  })

  it('drops an echo this engine could not have produced rather than guessing', () => {
    expect(fromVenueClientOid('')).toBeUndefined() // venue sends "" when no clientOid was set
    expect(fromVenueClientOid('A'.repeat(BITGET_MAX_CLIENT_OID_LEN + 1))).toBeUndefined()
    expect(fromVenueClientOid('BTC 1')).toBeUndefined()
  })

  it('passes a foreign but well-formed key through unchanged (someone else’s order id)', () => {
    // It decodes to itself; the adapter then finds no matching intent and ignores the frame.
    expect(fromVenueClientOid('someOtherBot001')).toBe('someOtherBot001')
  })
})
