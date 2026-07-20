/**
 * Unit: deterministic clientOrderId codec (`11` §4). Asserts the format is
 * byte-identical to the engine's legacy inline strings (no golden churn), round-trips
 * `make`/`parse` including hyphen-bearing `intentId`s, and fails loud on malformed input
 * and the venue length/charset guardrails.
 */

import { describe, expect, it } from 'vitest'
import {
  type ClientOrderIdParts,
  MAX_CLIENT_ORDER_ID_LEN,
  makeClientOrderId,
  parseClientOrderId,
} from '../../../../src/core/order-id/client-order-id.js'

describe('makeClientOrderId', () => {
  it('reproduces the legacy inline format byte-for-byte', () => {
    // Engine used `${intentId}-entry-1` / `${intentId}-exit-1`; intentId = `${symbol}-${ts}`.
    expect(makeClientOrderId({ intentId: 'BTC-28710000', leg: 'entry', attempt: 1 })).toBe('BTC-28710000-entry-1')
    expect(makeClientOrderId({ intentId: 'BTC-28710000', leg: 'exit', attempt: 1 })).toBe('BTC-28710000-exit-1')
    // A real 13-digit epoch-ms intent id stays well under the 36-char cap.
    expect(makeClientOrderId({ intentId: 'ETH-1737331200000', leg: 'entry', attempt: 1 })).toBe(
      'ETH-1737331200000-entry-1',
    )
  })

  it('rejects a hyphen in the leg (it is the segment separator)', () => {
    expect(() => makeClientOrderId({ intentId: 'BTC-1', leg: 'en-try', attempt: 1 })).toThrow(/hyphen-free/)
  })

  it('rejects a non-positive-int attempt', () => {
    expect(() => makeClientOrderId({ intentId: 'BTC-1', leg: 'entry', attempt: 0 })).toThrow(/positive integer/)
    expect(() => makeClientOrderId({ intentId: 'BTC-1', leg: 'entry', attempt: 1.5 })).toThrow(/positive integer/)
  })

  it('rejects an id over the venue length cap', () => {
    const longIntent = `BTC-${'9'.repeat(40)}`
    expect(() => makeClientOrderId({ intentId: longIntent, leg: 'entry', attempt: 1 })).toThrow(
      new RegExp(`exceeds ${MAX_CLIENT_ORDER_ID_LEN}`),
    )
  })

  it('rejects an out-of-charset id', () => {
    expect(() => makeClientOrderId({ intentId: 'BTC/USDT', leg: 'entry', attempt: 1 })).toThrow(
      /outside \[A-Za-z0-9_-\]/,
    )
  })
})

describe('parseClientOrderId', () => {
  it('round-trips make → parse, keeping a hyphen-bearing intentId intact', () => {
    const parts: ClientOrderIdParts = { intentId: 'BTC-28710000', leg: 'entry', attempt: 1 }
    expect(parseClientOrderId(makeClientOrderId(parts))).toEqual(parts)
  })

  it('splits off exactly the last two segments', () => {
    expect(parseClientOrderId('ETH-1737331200000-exit-2')).toEqual({
      intentId: 'ETH-1737331200000',
      leg: 'exit',
      attempt: 2,
    })
  })

  it('fails loud on a string this codec did not produce', () => {
    expect(() => parseClientOrderId('nodash')).toThrow(/not a/)
    expect(() => parseClientOrderId('one-two')).toThrow(/not a/)
  })
})
