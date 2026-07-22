/**
 * Scenario: **Strategy S4.1a — post-funding LONG ladder** (`05_strategy_4_1a.md` §2/§3). Drives the
 * real S4.1a module + ladder `sl_tp_deadline` handler through the sim venue on the virtual clock.
 * Five BUY-LIMIT rungs rest below the pre-event price; an engine-side conditional SL is armed at
 * placement; the drop fills rungs and the reduce-only TP is re-placed per fill.
 *
 *  (a) **tp_hit** — all rungs fill, then the rebound reaches the TP → CLOSED{tp_hit};
 *  (b) **sl_hit (partial)** — only 2 of 5 fill, then the engine-side SL fires and closes exactly the
 *      filled qty; the unfilled rungs are cancelled;
 *  (c) **ladder_no_fills** — no rung ever fills → NO_POSITION{ladder_no_fills}, all rungs cancelled, zero fees;
 *  (d) **pre-settlement fill** — a rung fills before `T_settle` → kept, `ladder.pre_funding_fill` emitted,
 *      funding accrues on the open position;
 *  (e) **late-dip TP re-place** — a later rung fill after a TP is resting re-places the TP with the new qty;
 *  (f) **cancel/fill race** — a rung reported filled while the exit is in flight → protective reduce-only close.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FundingFeeAccrued, OrderUpdate } from '../../src/core/events/types.js'
import { makeClientOrderId } from '../../src/core/order-id/client-order-id.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import { withPlacements } from '../helpers/s3a-scenario.js'
import {
  buildS4_1aEngine,
  DEADLINE_TS,
  driveToLadderResting,
  driveToSettledNoFill,
  TOTAL_QTY,
} from '../helpers/s4-1a-scenario.js'
import { BTC, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

function build(onOpsEvent?: (e: { kind: string; intentId: string; symbol: string }) => void): SkeletonHarness {
  return pool.track(buildS4_1aEngine({ startMs: START_MS, walPath: tmp.walPath, onOpsEvent }))
}

/** Last WAL transition for an intent → its `[to, exitReason?, errorCode?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string; errorCode?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  const payload = last?.payload as { exitReason?: string; errorCode?: string } | undefined
  return { to: last?.toState ?? '', exitReason: payload?.exitReason, errorCode: payload?.errorCode }
}

/** Collect every CANCELLED entry-rung client order id. */
function cancelledRungs(h: SkeletonHarness): Set<string> {
  const cancelled = new Set<string>()
  h.bus.subscribe((e: OrderUpdate | { type: string }) => {
    if (e.type === 'OrderUpdate') {
      const u = e as OrderUpdate
      if (u.status === 'CANCELLED' && u.clientOrderId.includes('-entry-')) cancelled.add(u.clientOrderId)
    }
  })
  return cancelled
}

beforeEach(() => {
  tmp = tempDir('s4-1a-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S4.1a ladder', () => {
  it('(a) all rungs fill then the rebound reaches the TP → CLOSED{tp_hit}, TP sized to the full fill', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_600) // below the bottom rung, above the SL → all five fill
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_920) // ≥ TP limit → the resting SELL LIMIT fills

    // Five BUY-LIMIT rungs went out (reduce-only false, LONG); the top rung is the most favorable.
    const entries = placements.filter((p) => p.req.clientOrderId.includes('-entry-'))
    expect(entries).toHaveLength(5)
    expect(entries[0]?.req).toMatchObject({ side: 'long', type: 'limit', price: 59_853 })
    expect(entries[0]?.req.reduceOnly).toBeUndefined()

    // The resting TP is a reduce-only SELL LIMIT sized to the aggregate filled qty (re-placed per fill).
    const tps = placements.filter((p) => p.req.clientOrderId.includes('-tp-'))
    expect(tps[tps.length - 1]?.req).toMatchObject({ side: 'short', type: 'limit', reduceOnly: true, qty: TOTAL_QTY })

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'tp_hit' })
  })

  it('(b) only 2 of 5 fill then the engine-side SL fires → CLOSED{sl_hit} closing exactly the filled qty', () => {
    const h = build()
    const placements = withPlacements(h)
    const cancelled = cancelledRungs(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_750) // fills the top two rungs only
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_200) // below the engine SL trigger → sl_hit

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'sl_hit' })
    // The reduce-only market close is sized to the *filled* qty (2 rungs = 0.002), not the planned 0.005.
    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(exit?.req).toMatchObject({ side: 'short', type: 'market', reduceOnly: true, qty: 0.002 })
    // The three unfilled rungs are cancelled at exit (`05` §2 step 4).
    expect(cancelled.size).toBe(3)
  })

  it('(c) no rung fills by the deadline → NO_POSITION{ladder_no_fills}, all rungs cancelled, zero fees', () => {
    const h = build()
    const cancelled = cancelledRungs(h)
    const fills: OrderUpdate[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'OrderUpdate' && e.status === 'FILLED') fills.push(e)
    })

    driveToSettledNoFill(h) // rungs rest, price never drops
    h.clock.advanceTo(DEADLINE_TS)

    expect(h.engine.intentState(INTENT_ID)).toBe('NO_POSITION')
    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'NO_POSITION', errorCode: 'ladder_no_fills' })
    expect(cancelled.size).toBe(5)
    expect(fills).toHaveLength(0) // nothing filled ⇒ no fees
  })

  it('(d) a rung fills before T_settle → kept, ladder.pre_funding_fill emitted, funding accrues', () => {
    const opsEvents: { kind: string; intentId: string; symbol: string }[] = []
    const h = build((e) => opsEvents.push(e))
    const fundingFees: FundingFeeAccrued[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'FundingFeeAccrued') fundingFees.push(e)
    })

    driveToLadderResting(h)
    h.clock.advanceTo(SETTLE_TS - 1_000)
    h.exchange.setPrice(BTC.symbol, 59_750) // top two rungs fill a candle before settlement

    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(opsEvents).toContainEqual({ kind: 'ladder.pre_funding_fill', intentId: INTENT_ID, symbol: BTC.symbol })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)

    h.clock.advanceTo(SETTLE_TS)
    h.exchange.settleFunding(BTC.symbol, -0.35, SETTLE_TS) // long, negative rate ⇒ credit
    expect(fundingFees).toHaveLength(1)
    expect(fundingFees[0]?.amount).toBeGreaterThan(0)
  })

  it('(e) a later dip fills another rung after the TP is resting → TP re-placed with the new qty', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_750) // rungs 0,1 → TP resting at qty 0.002
    const tpsAfterTwo = placements.filter((p) => p.req.clientOrderId.includes('-tp-')).length

    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_700) // rung 2 dips in → TP re-placed at qty 0.003

    const tps = placements.filter((p) => p.req.clientOrderId.includes('-tp-'))
    expect(tps.length).toBeGreaterThan(tpsAfterTwo)
    expect(tps[tps.length - 1]?.req.qty).toBe(0.003)
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
  })

  it('(f) a rung reported filled while the exit is in flight → protective reduce-only close', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_750) // rungs 0,1 fill → MONITORING; rung 2 still resting

    // Suppress the deadline market-close ack so the intent lingers in EXITING (the race window).
    h.exchange.disconnectPrivate(DEADLINE_TS - 1_000, DEADLINE_TS + 10_000)
    h.clock.advanceTo(DEADLINE_TS)
    expect(h.engine.intentState(INTENT_ID)).toBe('EXITING')

    // The venue now reports rung 2 filling — cancel/fill race — while the exit is still in flight.
    const rung2Coid = makeClientOrderId({ intentId: INTENT_ID, leg: 'entry', attempt: 3 })
    h.bus.publish({ type: 'OrderUpdate', clientOrderId: rung2Coid, status: 'FILLED', fillPx: 59_700, qty: 0.001 })

    const protect = placements.find((p) => p.req.clientOrderId.includes('-protect-'))
    expect(protect?.req).toMatchObject({ side: 'short', type: 'market', reduceOnly: true, qty: 0.001 })
  })
})
