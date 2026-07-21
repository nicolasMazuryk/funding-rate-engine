/**
 * Scenario: **Strategy S1-WS — funding-fee-event exit** (`02_strategy_1_ws.md` §2/§3).
 * Drives the real S1-WS module + `funding_fee_event` handler (owning the funding gate)
 * through the sim venue on the virtual clock. The exit is gated on *confirmed accrual*,
 * so it converges from three paths — all resolving through the engine's out-of-band
 * `requestExit` seam:
 *
 *  (a) **WS event** — a `funding_fee` within ±5 s of `T_settle` opens the gate → exit
 *      `funding_fee_event`; the exit never fires before the gate opens.
 *  (b) **REST poll** — WS suppressed but the income ledger has the credit → the poll at
 *      `T_settle + 3 s` opens the gate → exit `funding_fee_event`.
 *  (c) **timeout** — no accrual at all → exit at exactly `T_settle + timeout`,
 *      `funding_fee_timeout`.
 *  (d) **mismatched cycle** — a `funding_fee` 6 s off `T_settle` is outside ±5 s and does
 *      not exit early (the tight tolerance is an intended failure mode, `02` §3).
 *
 * The async REST poll / timeout resolve on a microtask after `clock.advanceTo`, so those
 * paths need a `flush()` (mirrors `funding-gate.test.ts`); the WS path is synchronous.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import { buildS1WsEngine, GATE_TIMEOUT_TS, REST_POLL_TS } from '../helpers/s1-ws-scenario.js'
import { BTC, driveToEntry, ENTRY_TS, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

let tmp: TempDir
const pool = harnessPool()

/** Flush queued microtasks so the async REST poll's `.then` resolves after a clock advance. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function build(): SkeletonHarness {
  return pool.track(buildS1WsEngine({ startMs: START_MS, walPath: tmp.walPath }))
}

/** Last WAL transition for an intent → its `[to, exitReason?]`. */
function lastTransition(h: SkeletonHarness, intentId: string): { to: string; exitReason?: string } {
  const rows = h.wal.readAll().filter((r) => r.intentId === intentId)
  const last = rows[rows.length - 1]
  return { to: last?.toState ?? '', exitReason: (last?.payload as { exitReason?: string } | undefined)?.exitReason }
}

/** Wrap `placeOrder` to record the clock instant each order is placed at. */
function withPlacements(h: SkeletonHarness): Array<{ req: OrderRequest; ts: number }> {
  const placements: Array<{ req: OrderRequest; ts: number }> = []
  const rawPlace = h.exchange.placeOrder.bind(h.exchange)
  h.exchange.placeOrder = (req: OrderRequest): Promise<OrderAck> => {
    placements.push({ req, ts: h.clock.now() })
    return rawPlace(req)
  }
  return placements
}

beforeEach(() => {
  tmp = tempDir('s1-ws-scenario-')
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('scenario: strategy S1-WS funding-fee-event exit', () => {
  it('(a) WS funding_fee opens the gate → exit only after gate open, CLOSED{funding_fee_event}', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToEntry(h)
    h.clock.advanceTo(SETTLE_TS)

    // Before any accrual the gate is armed but closed → MONITORING, no exit placed yet.
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(placements.some((p) => p.req.clientOrderId.includes('-exit-'))).toBe(false)

    // WS funding-fee 4 s after T_settle (inside ±5 s) opens the gate → reduce-only exit.
    h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS + 4_000)

    const entry = placements.find((p) => p.req.clientOrderId.includes('-entry-'))
    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    // Ordering: entry fill before T_settle; the gate opens (and the exit fires) at/after T_settle.
    expect(entry?.ts).toBe(ENTRY_TS)
    expect(ENTRY_TS).toBeLessThan(SETTLE_TS)
    expect(exit?.req.reduceOnly).toBe(true)
    expect(exit?.req.side).toBe('short')
    expect(exit?.ts).toBe(SETTLE_TS) // fired synchronously on gate open, never before
    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'funding_fee_event' })
    expect(h.engine.fundingReceived(INTENT_ID)).toBe(true)
  })

  it('(b) dropped WS but ledger credit → REST poll opens the gate at T_settle+3 s, CLOSED{funding_fee_event}', async () => {
    const h = build()
    const placements = withPlacements(h)

    driveToEntry(h)
    h.clock.advanceTo(SETTLE_TS)
    h.exchange.dropFundingFee() // suppress the WS event; the income ledger still records the credit
    h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS)
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING') // WS suppressed → still armed

    h.clock.advanceTo(REST_POLL_TS) // the REST safety-net poll fires
    await flush()

    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(exit?.ts).toBe(REST_POLL_TS)
    expect(exit?.req.reduceOnly).toBe(true)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'funding_fee_event' })
  })

  it('(c) no accrual → exit at exactly T_settle+timeout, CLOSED{funding_fee_timeout}', async () => {
    const h = build()
    const placements = withPlacements(h)

    driveToEntry(h)
    h.clock.advanceTo(REST_POLL_TS) // poll fires against an empty ledger → no open
    await flush()
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(GATE_TIMEOUT_TS - 1) // one ms before the timeout → still monitoring
    await flush()
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')

    h.clock.advanceTo(GATE_TIMEOUT_TS)
    await flush()

    const exit = placements.find((p) => p.req.clientOrderId.includes('-exit-'))
    expect(exit?.ts).toBe(GATE_TIMEOUT_TS)
    expect(lastTransition(h, INTENT_ID)).toEqual({ to: 'CLOSED', exitReason: 'funding_fee_timeout' })
  })

  it('(d) a funding_fee 6 s off T_settle is outside ±5 s → does not exit early', () => {
    const h = build()
    const placements = withPlacements(h)

    driveToEntry(h)
    h.clock.advanceTo(SETTLE_TS)
    // 6 s off T_settle: outside the ±5 s window → no gate match, no early exit.
    h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS + 6_000)

    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(placements.some((p) => p.req.clientOrderId.includes('-exit-'))).toBe(false)
  })
})
