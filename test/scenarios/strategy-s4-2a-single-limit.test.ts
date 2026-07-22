/**
 * Scenario: **Strategy S4.2a — post-funding LONG single limit** (`06_strategy_4_2a.md` §2/§3). Drives
 * the real S4.2a module + ladder `sl_tp_deadline` handler through the sim venue on the virtual clock.
 * ONE BUY-LIMIT rests below the pre-event price carrying `expireAt`; an engine-side conditional SL is
 * armed at placement; a dip fills it and the reduce-only TP is placed on the fill.
 *
 *  (a) **tp_hit** — the limit fills, then the rebound reaches the TP → CLOSED{tp_hit};
 *  (b) **sl_hit** — the limit fills, then the drop crosses the engine-side SL → CLOSED{sl_hit};
 *  (c) **fill-and-immediate-stop** — the limit fills and the SL triggers within the same virtual
 *      second → CLOSED{sl_hit} (`06` §3, verification #3);
 *  (d) **limit_expired** — the limit never fills → NO_POSITION{limit_expired}, cancelled/expired, zero
 *      fees, SL disarmed (`06` §2 R5, verification #2);
 *  (e) **pre-settlement fill** — the limit fills before `T_settle` → kept, `ladder.pre_funding_fill`
 *      emitted, funding accrues on the open position (§G-R);
 *  (f) **deadline with open position** → SELL MARKET reduce-only close, CLOSED{deadline}.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FundingFeeAccrued, OrderUpdate } from '../../src/core/events/types.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import { withPlacements } from '../helpers/s3a-scenario.js'
import {
  buildS4_2aEngine,
  DEADLINE_TS,
  driveToLimitResting,
  driveToSettledNoFill,
  TOTAL_QTY,
} from '../helpers/s4-2a-scenario.js'
import { BTC, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

function build(onOpsEvent?: (e: { kind: string; intentId: string; symbol: string }) => void): SkeletonHarness {
  return pool.track(buildS4_2aEngine({ startMs: START_MS, walPath: tmp.walPath, onOpsEvent }))
}

/** Last WAL transition for an intent → its `[to, exitReason?, errorCode?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string; errorCode?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  const payload = last?.payload as { exitReason?: string; errorCode?: string } | undefined
  return { to: last?.toState ?? '', exitReason: payload?.exitReason, errorCode: payload?.errorCode }
}

/** Collect entry-rung terminal (CANCELLED / EXPIRED) client order ids. */
function deadEntries(h: SkeletonHarness): Set<string> {
  const dead = new Set<string>()
  h.bus.subscribe((e: OrderUpdate | { type: string }) => {
    if (e.type === 'OrderUpdate') {
      const u = e as OrderUpdate
      if ((u.status === 'CANCELLED' || u.status === 'EXPIRED') && u.clientOrderId.includes('-entry-')) {
        dead.add(u.clientOrderId)
      }
    }
  })
  return dead
}

beforeEach(() => {
  tmp = tempDir('s4-2a-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S4.2a single limit', () => {
  it('(a) the limit fills then the rebound reaches the TP → CLOSED{tp_hit}, TP sized to the fill', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_800) // below the limit, above the SL → the single limit fills
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_970) // ≥ TP limit → the resting SELL LIMIT fills

    // One BUY-LIMIT went out (reduce-only false, LONG) carrying an expireAt.
    const entries = placements.filter((p) => p.req.clientOrderId.includes('-entry-'))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.req).toMatchObject({ side: 'long', type: 'limit', price: 59_842.5, expireAt: DEADLINE_TS })
    expect(entries[0]?.req.reduceOnly).toBeUndefined()

    // The resting TP is a reduce-only SELL LIMIT sized to the filled qty.
    const tps = placements.filter((p) => p.req.clientOrderId.includes('-tp-'))
    expect(tps[tps.length - 1]?.req).toMatchObject({ side: 'short', type: 'limit', reduceOnly: true, qty: TOTAL_QTY })

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'tp_hit' })
  })

  it('(b) the limit fills then the engine-side SL fires → CLOSED{sl_hit} closing the filled qty', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_800) // fills the limit
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(SETTLE_TS + 2_000)
    h.exchange.setPrice(BTC.symbol, 59_500) // below the engine SL trigger → sl_hit

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'sl_hit' })
    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(exit?.req).toMatchObject({ side: 'short', type: 'market', reduceOnly: true, qty: TOTAL_QTY })
  })

  it('(c) the limit fills and the SL triggers within the same virtual second → CLOSED{sl_hit}', () => {
    const h = build()

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    // Deep-drop candle: two ticks at the SAME instant — the first fills the limit (→ MONITORING),
    // the second crosses the engine-side SL. No clock advance between them (`06` §3).
    h.exchange.setPrice(BTC.symbol, 59_842.5) // fills at the limit price
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    h.exchange.setPrice(BTC.symbol, 59_400) // below the SL trigger, same virtual second

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'sl_hit' })
  })

  it('(d) the limit never fills by the deadline → NO_POSITION{limit_expired}, cancelled, zero fees, SL disarmed', () => {
    const h = build()
    const placements = withPlacements(h)
    const dead = deadEntries(h)
    const fills: OrderUpdate[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'OrderUpdate' && e.status === 'FILLED') fills.push(e)
    })

    driveToSettledNoFill(h) // the limit rests, price never dips
    h.clock.advanceTo(DEADLINE_TS)

    expect(h.engine.intentState(INTENT_ID)).toBe('NO_POSITION')
    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'NO_POSITION', errorCode: 'limit_expired' })
    expect(dead.size).toBe(1) // the single limit is cancelled/expired
    expect(fills).toHaveLength(0) // nothing filled ⇒ no fees
    // SL disarmed: a post-terminal drop below the trigger fires no exit/protective close.
    h.clock.advanceTo(DEADLINE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_000)
    expect(placements.some((p) => p.req.clientOrderId.includes('-exit-'))).toBe(false)
    expect(h.engine.intentState(INTENT_ID)).toBe('NO_POSITION')
  })

  it('(e) the limit fills before T_settle → kept, ladder.pre_funding_fill emitted, funding accrues', () => {
    const opsEvents: { kind: string; intentId: string; symbol: string }[] = []
    const h = build((e) => opsEvents.push(e))
    const fundingFees: FundingFeeAccrued[] = []
    h.bus.subscribe((e) => {
      if (e.type === 'FundingFeeAccrued') fundingFees.push(e)
    })

    driveToLimitResting(h)
    h.clock.advanceTo(SETTLE_TS - 1_000)
    h.exchange.setPrice(BTC.symbol, 59_800) // the limit fills a candle before settlement

    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(opsEvents).toContainEqual({ kind: 'ladder.pre_funding_fill', intentId: INTENT_ID, symbol: BTC.symbol })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)

    h.clock.advanceTo(SETTLE_TS)
    h.exchange.settleFunding(BTC.symbol, -0.35, SETTLE_TS) // long, negative rate ⇒ credit
    expect(fundingFees).toHaveLength(1)
    expect(fundingFees[0]?.amount).toBeGreaterThan(0)
  })

  it('(f) an open position hits the deadline → SELL MARKET reduce-only close, CLOSED{deadline}', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToSettledNoFill(h)
    h.clock.advanceTo(SETTLE_TS + 1_000)
    h.exchange.setPrice(BTC.symbol, 59_800) // fills → MONITORING, no TP/SL touched afterwards
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(DEADLINE_TS) // deadline market-closes the open position

    expect(lastTransition(h, INTENT_ID)).toMatchObject({ to: 'CLOSED', exitReason: 'deadline' })
    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(exit?.req).toMatchObject({ side: 'short', type: 'market', reduceOnly: true, qty: TOTAL_QTY })
  })
})
