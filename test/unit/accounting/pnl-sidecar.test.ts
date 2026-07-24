/**
 * Unit tier (task 0390) — the accounting sidecar (`src/accounting/pnl-sidecar.ts`).
 * Drives the `onTradeClose` hook against a fake repo (no Postgres): the settled
 * funding amount is read from `funding_events` (venue-sourced, never `|F|`), fed to
 * the assembler, and written idempotently. Covers the funding nearest-match, the
 * no-accrual short-circuit, and the fire-and-forget swallow.
 */

import { describe, expect, it, vi } from 'vitest'
import { createPnlSidecar } from '../../../src/accounting/pnl-sidecar.js'
import type { FundingEventRange, FundingEventRecord, PnlRecordRow, Repo } from '../../../src/core/ports/repo.js'
import type { TradeCloseContext } from '../../../src/core/runtime/engine.js'

/** Assert exactly one write happened and return it (narrows the possibly-undefined index access). */
function onlyWrite(writes: readonly PnlRecordRow[]): PnlRecordRow {
  expect(writes).toHaveLength(1)
  const [row] = writes
  if (row === undefined) throw new Error('no pnl row written')
  return row
}

const FEES = { takerFeePct: 0.05, makerFeePct: 0.02 }

function baseCtx(overrides: Partial<TradeCloseContext> = {}): TradeCloseContext {
  return {
    intentId: 'i1',
    symbol: 'BTC',
    strategyId: 's1',
    entrySide: 'long',
    exitReason: 'timed',
    pEntry: 100,
    pExit: 101,
    entryQty: 2,
    filledQty: 2,
    fillCount: 1,
    fundingReceived: true,
    enteredAtMs: 1_000,
    closedAtMs: 61_000,
    tSettleMs: 500,
    ...overrides,
  }
}

/** A repo carrying only the accounting writers; funding events are canned, writes captured. */
function fakeRepo(fundingEvents: readonly FundingEventRecord[]): {
  repo: Repo
  writes: PnlRecordRow[]
} {
  const writes: PnlRecordRow[] = []
  const repo = {
    async upsertIntentState(): Promise<void> {},
    async loadNonTerminalIntents(): Promise<readonly []> {
      return []
    },
    async upsertPnl(record: PnlRecordRow): Promise<void> {
      writes.push(record)
    },
    async loadFundingEventsForSymbol(symbol: string, range: FundingEventRange): Promise<readonly FundingEventRecord[]> {
      return fundingEvents.filter(
        (e) => e.symbol === symbol && e.fundingTime >= range.fromMs && e.fundingTime <= range.toMs,
      )
    },
  } satisfies Repo
  return { repo, writes }
}

/** Flush the sidecar's fire-and-forget promise chain. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('createPnlSidecar', () => {
  it('books the settled venue amount (≠ |F|) — the drop nearest T_settle', async () => {
    // Two drops in-window; the one at 480 is nearer T_settle=500 than 900. Amount is the venue
    // credit, not any |F|·notional derivation.
    const { repo, writes } = fakeRepo([
      { symbol: 'BTC', fundingTime: 480, amount: 1.37, rate: -0.4 },
      { symbol: 'BTC', fundingTime: 900, amount: 5, rate: -0.4 },
    ])
    createPnlSidecar({ repo, fees: FEES }).onTradeClose(baseCtx())
    await flush()

    const row = onlyWrite(writes)
    expect(row.fundingPnl).toBeCloseTo(1.37, 10)
    // net = delta(2) + funding(1.37) − fee(0.2)
    expect(row.netPnl).toBeCloseTo(2 + 1.37 - 0.2, 10)
  })

  it('books venue funding even when the entry-timing verdict is false (S6 PRE-leg case, R7)', async () => {
    // Venue credited a settled funding event, though the entry-before-settle verdict reads false
    // (S6's MAIN lands after settle). Ground truth wins — book it.
    const { repo, writes } = fakeRepo([{ symbol: 'BTC', fundingTime: 500, amount: 9 }])
    createPnlSidecar({ repo, fees: FEES }).onTradeClose(baseCtx({ strategyId: 's6', fundingReceived: false }))
    await flush()
    expect(onlyWrite(writes).fundingPnl).toBeCloseTo(9, 10)
  })

  it('books zero funding when the venue recorded no settled event', async () => {
    const { repo, writes } = fakeRepo([])
    createPnlSidecar({ repo, fees: FEES }).onTradeClose(baseCtx({ fundingReceived: true }))
    await flush()
    expect(onlyWrite(writes).fundingPnl).toBe(0)
  })

  it('swallows a write error — never throws into the hot path', async () => {
    const repo = {
      async upsertIntentState(): Promise<void> {},
      async loadNonTerminalIntents(): Promise<readonly []> {
        return []
      },
      async upsertPnl(): Promise<void> {
        throw new Error('db down')
      },
      async loadFundingEventsForSymbol(): Promise<readonly FundingEventRecord[]> {
        return []
      },
    } satisfies Repo
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => createPnlSidecar({ repo, fees: FEES }).onTradeClose(baseCtx())).not.toThrow()
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('books a NO_POSITION terminal with zero economics and no funding read', async () => {
    const { repo, writes } = fakeRepo([])
    createPnlSidecar({ repo, fees: FEES }).onTradeClose(
      baseCtx({ exitReason: undefined, errorCode: 'limit_expired', fundingReceived: false, filledQty: undefined }),
    )
    await flush()
    expect(onlyWrite(writes)).toMatchObject({ netPnl: 0, feeCost: 0, fillCount: 0, errorCode: 'limit_expired' })
  })
})
