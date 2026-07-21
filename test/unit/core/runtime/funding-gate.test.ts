/**
 * Pure-matcher unit tests for the funding gate (task 0290; `00_globals.md` §6, `02` §2/§3).
 * Drives {@link createFundingGate} against a virtual clock and an in-memory funding-income
 * ledger (mirroring the sim's `fundingIncome` future-filter) — no bus, no venue. Covers the
 * ±5 s tolerance boundary, once-only open, `tDropOffsetS`, serialize/restore, timeout
 * suppression, restore-inert, and the both-timers-past-due restore race.
 */

import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import type { FundingFeeAccrued } from '../../../../src/core/events/types.js'
import type { FundingIncome } from '../../../../src/core/ports/exchange-adapter.js'
import {
  createFundingGate,
  type FundingIncomePoll,
  type GateSignal,
} from '../../../../src/core/runtime/funding-gate.js'

const SETTLE = 10_000

/** Flush queued microtasks so the async REST poll's `.then` runs after a clock advance. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function setup(startMs = 0) {
  const clock = createVirtualClock(startMs)
  const signals: GateSignal[] = []
  const ledger: FundingIncome[] = []
  const poll: FundingIncomePoll = (symbol, range) =>
    Promise.resolve(
      ledger.filter(
        (r) =>
          r.symbol === symbol &&
          r.fundingTime >= range.fromTs &&
          r.fundingTime <= range.toTs &&
          r.fundingTime <= clock.now(),
      ),
    )
  const gate = createFundingGate({ clock, poll, observer: (s) => signals.push(s) })
  return { clock, signals, ledger, gate }
}

function fee(fundingTime: number, symbol = 'BTC'): FundingFeeAccrued {
  return { type: 'FundingFeeAccrued', symbol, amount: -1, fundingTime }
}

const opens = (s: readonly GateSignal[]) => s.filter((x) => x.type === 'GateOpened')
const closes = (s: readonly GateSignal[]) =>
  s.filter((x): x is Extract<GateSignal, { type: 'GateClosed' }> => x.type === 'GateClosed')

describe('funding gate — WS match tolerance', () => {
  it('matches a fee exactly ±5 s from T_settle (inclusive)', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.gate.onFundingFee(fee(SETTLE + 5_000))
    expect(opens(h.signals)).toHaveLength(1)
    expect(opens(h.signals)[0]).toMatchObject({ source: 'ws', tDropOffsetS: 5 })
    expect(h.gate.isOpen('i1')).toBe(true)
  })

  it('rejects a fee 6 s from T_settle (outside ±5 s)', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.gate.onFundingFee(fee(SETTLE + 6_000))
    expect(opens(h.signals)).toHaveLength(0)
    expect(h.gate.isOpen('i1')).toBe(false)
  })

  it('computes a negative tDropOffsetS when T_drop precedes T_settle', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.gate.onFundingFee(fee(SETTLE - 2_000))
    expect(opens(h.signals)[0]).toMatchObject({ source: 'ws', tDropOffsetS: -2 })
  })

  it('ignores a fee on a different symbol', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.gate.onFundingFee(fee(SETTLE, 'ETH'))
    expect(h.gate.isOpen('i1')).toBe(false)
  })
})

describe('funding gate — once-only', () => {
  it('opens exactly once on a duplicate WS event', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    const e = fee(SETTLE)
    h.gate.onFundingFee(e)
    h.gate.onFundingFee(e)
    expect(opens(h.signals)).toHaveLength(1)
    expect(closes(h.signals).filter((c) => c.reason === 'opened')).toHaveLength(1)
  })

  it('suppresses the timeout after the gate opened', async () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.gate.onFundingFee(fee(SETTLE))
    h.clock.advanceTo(SETTLE + 30_000) // timeout instant — must not fire
    await flush()
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(0)
  })
})

describe('funding gate — REST safety net', () => {
  it('opens on the poll at T_settle+3 s when the ledger holds the credit (source rest, offset 0)', async () => {
    const h = setup()
    h.ledger.push({ symbol: 'BTC', amount: -1, fundingTime: SETTLE })
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.clock.advanceTo(SETTLE + 3_000)
    await flush()
    expect(opens(h.signals)[0]).toMatchObject({ source: 'rest', tDropOffsetS: 0 })
  })

  it('does not open on a future credit the poll cannot yet see, then times out', async () => {
    const h = setup()
    h.ledger.push({ symbol: 'BTC', amount: -1, fundingTime: SETTLE + 6_000 }) // future at poll time
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.clock.advanceTo(SETTLE + 3_000)
    await flush()
    expect(opens(h.signals)).toHaveLength(0)
    h.clock.advanceTo(SETTLE + 30_000)
    await flush()
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(1)
  })
})

describe('funding gate — timeout', () => {
  it('fires exactly at T_settle+timeout, not one ms before', async () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    h.clock.advanceTo(SETTLE + 30_000 - 1)
    await flush()
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(0)
    h.clock.advanceTo(SETTLE + 30_000)
    await flush()
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(1)
  })
})

describe('funding gate — serialize / restore', () => {
  it('round-trips an armed gate and an opened gate', () => {
    const h = setup()
    h.gate.arm({ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30 })
    expect(h.gate.serialize()[0]).toMatchObject({ intentId: 'i1', status: 'armed' })
    h.gate.onFundingFee(fee(SETTLE + 4_000))
    expect(h.gate.serialize()[0]).toMatchObject({
      status: 'open',
      source: 'ws',
      observedFundingTime: SETTLE + 4_000,
    })
  })

  it('restores an already-open gate inert — no re-emit, no re-schedule', async () => {
    const h = setup()
    h.gate.restore([
      {
        intentId: 'i1',
        symbol: 'BTC',
        settleTs: SETTLE,
        timeoutSeconds: 30,
        status: 'open',
        source: 'ws',
        observedFundingTime: SETTLE,
      },
    ])
    h.clock.advanceTo(SETTLE + 1_000_000)
    await flush()
    expect(h.signals).toHaveLength(0)
    expect(h.gate.isOpen('i1')).toBe(true)
  })

  it('re-arms a still-armed gate; both timers past-due + a credit → rest open, not timeout', async () => {
    const h = setup(100_000) // clock already far past both scheduled instants
    h.ledger.push({ symbol: 'BTC', amount: -1, fundingTime: SETTLE })
    h.gate.restore([{ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30, status: 'armed' }])
    h.clock.advanceTo(100_000) // fire both past-due timers on the next tick
    await flush()
    expect(opens(h.signals)[0]).toMatchObject({ source: 'rest' })
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(0)
    expect(closes(h.signals).filter((c) => c.reason === 'opened')).toHaveLength(1)
  })

  it('re-arms a still-armed gate; both timers past-due + no credit → timeout', async () => {
    const h = setup(100_000)
    h.gate.restore([{ intentId: 'i1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: 30, status: 'armed' }])
    h.clock.advanceTo(100_000)
    await flush()
    expect(opens(h.signals)).toHaveLength(0)
    expect(closes(h.signals).filter((c) => c.reason === 'timeout')).toHaveLength(1)
  })
})
