/**
 * Unit: the OKX `clientOrderId` ↔ `clOrdId` codec. No sibling has this file because no prior
 * venue rejects the engine's key: OKX's `clOrdId` is alphanumeric-only and 32 chars, and the
 * engine's is `<intentId>-<leg>-<attempt>` inside `[A-Za-z0-9_-]` at up to 36. The two
 * properties that make the order path work are pinned here — **determinism** (a retry
 * re-derives the same key, which is what `11` §4 idempotency rests on) and **round-tripping**
 * (the `orders` channel echoes `clOrdId`, and the FSM is keyed on the engine's id).
 */

import { describe, expect, it } from 'vitest'
import {
  fromVenueClOrdId,
  OKX_MAX_CLORDID_LEN,
  toVenueClOrdId,
} from '../../../../../src/adapters/exchanges/okx/client-order-id.js'
import { makeClientOrderId } from '../../../../../src/core/order-id/client-order-id.js'

describe('toVenueClOrdId', () => {
  it('encodes a real engine id to an alphanumeric key OKX accepts', () => {
    expect(toVenueClOrdId('BTC-28710000-entry-1')).toBe('BTCxd28710000xdentryxd1')
  })

  it('leaves an already-alphanumeric id untouched', () => {
    expect(toVenueClOrdId('BTC1')).toBe('BTC1')
  })

  it('doubles a literal escape character so the mapping stays injective', () => {
    // 'exit' carries the escape char; without doubling, `xd` inside a leg would decode as '-'.
    expect(toVenueClOrdId('BTC-1-exit-1')).toBe('BTCxd1xdexxitxd1')
  })

  it('escapes the underscore OKX also rejects', () => {
    expect(toVenueClOrdId('A_B')).toBe('AxuB')
  })

  it('is deterministic — the same engine id always yields the same key (11 §4 idempotency)', () => {
    const id = makeClientOrderId({ intentId: 'PEPE-28710000', leg: 'exit', attempt: 2 })
    expect(toVenueClOrdId(id)).toBe(toVenueClOrdId(id))
  })

  it('fails loud rather than truncating past the venue ceiling', () => {
    const long = `${'A'.repeat(OKX_MAX_CLORDID_LEN)}-1-1`
    expect(() => toVenueClOrdId(long)).toThrow(/over the 32 limit/)
  })

  it('fails loud on a character no escape covers (never send an id the venue will reject)', () => {
    expect(() => toVenueClOrdId('BTC.1')).toThrow(/not alphanumeric/)
  })
})

describe('fromVenueClOrdId', () => {
  it('is the exact inverse over every id the engine can build', () => {
    const ids = [
      makeClientOrderId({ intentId: 'BTC-28710000', leg: 'entry', attempt: 1 }),
      makeClientOrderId({ intentId: 'BTC-28710000', leg: 'exit', attempt: 3 }),
      makeClientOrderId({ intentId: '1INCH-28710000', leg: 'preabort', attempt: 2 }),
      makeClientOrderId({ intentId: 'XRP-28710000', leg: 'protect', attempt: 1 }),
    ]
    for (const id of ids) expect(fromVenueClOrdId(toVenueClOrdId(id))).toBe(id)
  })

  it('drops a key this codec did not produce rather than decoding a plausible id', () => {
    expect(fromVenueClOrdId('BTCxq1')).toBeUndefined() // unknown escape letter
    expect(fromVenueClOrdId('BTCx')).toBeUndefined() // dangling trailing escape
  })

  it('passes an all-alphanumeric foreign key through unchanged (someone else’s order id)', () => {
    // No escape in it, so it decodes to itself — the adapter then finds no matching intent.
    expect(fromVenueClOrdId('someOtherBot001')).toBe('someOtherBot001')
  })
})
