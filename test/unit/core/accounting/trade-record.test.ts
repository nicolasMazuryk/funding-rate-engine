/**
 * Unit tier (task 0390) — the pure P&L decomposition assembler
 * (`src/core/accounting/trade-record.ts`). Per-strategy-family hand-computed §4
 * values (quote ccy — the deliberate §8.3 deviation), the recompute-from-components
 * identity property, and the NO_POSITION zero-economics terminal.
 */

import { describe, expect, it } from 'vitest'
import type { StrategyId } from '../../../../src/config/canonical.js'
import { assembleTradeRecord, type TradeFacts } from '../../../../src/core/accounting/trade-record.js'
import type { FeeInputs } from '../../../../src/core/runtime/cost-model.js'

const FEES: FeeInputs = { takerFeePct: 0.05, makerFeePct: 0.02 }

/** A closed-long base fact set: entry 100, exit 101, qty 2, no funding. Override per case. */
function longClose(overrides: Partial<TradeFacts> = {}): TradeFacts {
  return {
    intentId: 'i1',
    strategyId: 's1',
    entrySide: 'long',
    exitReason: 'timed',
    pEntry: 100,
    pExit: 101,
    entryQty: 2,
    filledQty: 2,
    fillCount: 1,
    settledFundingAmount: 0,
    fundingReceived: false,
    enteredAtMs: 1_000,
    closedAtMs: 61_000,
    tSettleMs: 500,
    fees: FEES,
    ...overrides,
  }
}

describe('assembleTradeRecord — Group L (s1/s1-ws/s2)', () => {
  it('books a long: deltaPnl = (Pexit − Pentry)·qty, fee = taker×2 pct × notional', () => {
    const r = assembleTradeRecord(longClose())
    // delta = (101 − 100) × 2 = 2; notional = 100 × 2 = 200; fee = (0.10/100) × 200 = 0.2
    expect(r.deltaPnl).toBeCloseTo(2, 10)
    expect(r.fundingPnl).toBe(0)
    expect(r.feeCost).toBeCloseTo(0.2, 10)
    expect(r.netPnl).toBeCloseTo(2 - 0.2, 10)
    expect(r.fillCount).toBe(1)
    expect(r.holdDurationS).toBe(60)
    expect(r.exitReason).toBe('timed')
  })

  it('books the settled funding amount (venue-sourced, never |F|) when accrued', () => {
    const r = assembleTradeRecord(longClose({ fundingReceived: true, settledFundingAmount: 1.37 }))
    expect(r.fundingPnl).toBeCloseTo(1.37, 10)
    expect(r.netPnl).toBeCloseTo(2 + 1.37 - 0.2, 10)
  })

  it('ignores the funding amount when the accrual verdict is false', () => {
    const r = assembleTradeRecord(longClose({ fundingReceived: false, settledFundingAmount: 99 }))
    expect(r.fundingPnl).toBe(0)
  })

  it('books a feeCostOverride verbatim (reconciliation venue-corrected fee, 0400)', () => {
    // Baseline config fee is 0.2; the venue-corrected override replaces it and re-derives netPnl.
    const r = assembleTradeRecord(longClose({ feeCostOverride: 0.35 }))
    expect(r.feeCost).toBeCloseTo(0.35, 10)
    expect(r.netPnl).toBeCloseTo(2 - 0.35, 10)
  })

  it('flips the delta sign for a short entry', () => {
    // short: profit when price falls. exit 101 > entry 100 ⇒ loss of 2.
    const r = assembleTradeRecord(longClose({ entrySide: 'short' }))
    expect(r.deltaPnl).toBeCloseTo(-2, 10)
  })

  it("S2's tp_hit exit books the maker-exit fee class (taker entry + maker exit)", () => {
    const r = assembleTradeRecord(longClose({ strategyId: 's2', exitReason: 'tp_hit' }))
    // fee pct = taker + maker = 0.07; fee = (0.07/100) × 200 = 0.14
    expect(r.feeCost).toBeCloseTo(0.14, 10)
  })
})

describe('assembleTradeRecord — S3a (Group S, short)', () => {
  it('tp_hit books taker+maker; sl_hit books taker×2', () => {
    const base = longClose({ strategyId: 's3a', entrySide: 'short', pEntry: 100, pExit: 99, filledQty: 2 })
    const tp = assembleTradeRecord({ ...base, exitReason: 'tp_hit' })
    const sl = assembleTradeRecord({ ...base, exitReason: 'sl_hit' })
    // notional 200. tp fee = 0.07/100×200 = 0.14; sl fee = 0.10/100×200 = 0.2
    expect(tp.feeCost).toBeCloseTo(0.14, 10)
    expect(sl.feeCost).toBeCloseTo(0.2, 10)
    // short delta on a favorable move: (100 − 99) × 2 = 2
    expect(tp.deltaPnl).toBeCloseTo(2, 10)
  })
})

describe('assembleTradeRecord — Group R (s4-1a/s4-2a ladder)', () => {
  it('books off P_avg, maker×2 TP fee, per-filled notional', () => {
    const r = assembleTradeRecord(
      longClose({
        strategyId: 's4-1a',
        exitReason: 'tp_hit',
        pEntry: undefined,
        pAvg: 100,
        filledQty: 3,
        fillCount: 3,
      }),
    )
    // notional = 100 × 3 = 300; maker×2 = 0.04 pct; fee = 0.04/100 × 300 = 0.12
    expect(r.feeCost).toBeCloseTo(0.12, 10)
    expect(r.pAvg).toBe(100)
    expect(r.pEntry).toBeUndefined()
    expect(r.fillCount).toBe(3)
    // delta = (101 − 100) × 3 = 3
    expect(r.deltaPnl).toBeCloseTo(3, 10)
  })

  it('SL/deadline exit books maker entry + taker exit', () => {
    const r = assembleTradeRecord(
      longClose({ strategyId: 's4-2a', exitReason: 'deadline', pEntry: undefined, pAvg: 100, filledQty: 3 }),
    )
    // fee pct = maker + taker = 0.07; fee = 0.07/100 × 300 = 0.21
    expect(r.feeCost).toBeCloseTo(0.21, 10)
  })
})

describe('assembleTradeRecord — S6 (Group D)', () => {
  it('books MAIN_DELTA + FUNDING_PRE − FEES with the full settled charge to FUNDING_PRE', () => {
    const facts = longClose({
      strategyId: 's6',
      entrySide: 'long',
      exitReason: 'tp_hit',
      pEntry: 100, // MAIN entry
      pExit: 102,
      filledQty: 2,
      fundingReceived: true,
      settledFundingAmount: -0.5, // a charge, booked whole to FUNDING_PRE
    })
    const r = assembleTradeRecord(facts)
    // MAIN_DELTA = (102 − 100) × 2 = 4; fee = s6Fees = taker×3 + maker = 0.17 pct × (100×2)=200 = 0.34
    expect(r.fundingPnl).toBeCloseTo(-0.5, 10)
    expect(r.deltaPnl).toBeCloseTo(4, 10)
    expect(r.feeCost).toBeCloseTo(0.34, 10)
    expect(r.netPnl).toBeCloseTo(4 - 0.5 - 0.34, 10)
  })
})

describe('assembleTradeRecord — NO_POSITION terminal', () => {
  it('limit_expired ⇒ net_pnl=0, fee_cost=0, zero fills, error_code set', () => {
    const r = assembleTradeRecord(
      longClose({
        strategyId: 's4-2a',
        exitReason: undefined,
        errorCode: 'limit_expired',
        pEntry: undefined,
        filledQty: undefined,
        enteredAtMs: undefined,
      }),
    )
    expect(r.netPnl).toBe(0)
    expect(r.feeCost).toBe(0)
    expect(r.deltaPnl).toBe(0)
    expect(r.fundingPnl).toBe(0)
    expect(r.fillCount).toBe(0)
    expect(r.errorCode).toBe('limit_expired')
    expect(r.holdDurationS).toBeUndefined()
  })

  it('ladder_no_fills books the same zero terminal', () => {
    const r = assembleTradeRecord(
      longClose({ strategyId: 's4-1a', exitReason: undefined, errorCode: 'ladder_no_fills', filledQty: undefined }),
    )
    expect(r.netPnl).toBe(0)
    expect(r.errorCode).toBe('ladder_no_fills')
  })
})

describe('assembleTradeRecord — property: net = delta + funding − fee (identity)', () => {
  const strategies: StrategyId[] = ['s1', 's1-ws', 's2', 's3a', 's4-1a', 's4-2a', 's6']
  for (const strategyId of strategies) {
    it(`holds for ${strategyId} across parameter variation`, () => {
      for (let i = 0; i < 20; i++) {
        const r = assembleTradeRecord(
          longClose({
            strategyId,
            pEntry: 100 + i,
            pAvg: strategyId.startsWith('s4') ? 100 + i : undefined,
            pExit: 100 + i * 1.5,
            entryQty: 1 + i,
            filledQty: 1 + i,
            fillCount: strategyId.startsWith('s4') ? 3 : 1,
            fundingReceived: i % 2 === 0,
            settledFundingAmount: i % 2 === 0 ? i * 0.1 - 1 : 0,
            exitReason: i % 3 === 0 ? 'tp_hit' : i % 3 === 1 ? 'sl_hit' : 'deadline',
          }),
        )
        expect(r.netPnl).toBeCloseTo(r.deltaPnl + r.fundingPnl - r.feeCost, 9)
      }
    })
  }
})
