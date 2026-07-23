/**
 * E2E tier (task 0350; `17` §4) — Strategy S6 through a full instance: scheduler → finder →
 * preflight → the entry sub-machine (PRE_FUNDING → funding-gate → MAIN reversal) → the
 * `sl_tp_deadline_post_funding_event` OCO → real Postgres + real local WAL, on the virtual clock +
 * sim venue. `bootInstance` auto-selects the S6 module + handler from the `s6` strategy id.
 *
 *  - **happy LONG (tp_hit)**: the five WAL transitions (SELECTED → SUBMITTING_ENTRY → MONITORING →
 *    EXITING → CLOSED) forwarded consistently, and `settledRatePercent` recorded on the MONITORING
 *    record (the settled |F| the OCO was priced off — `07` §2 step 4);
 *  - **funding_event_timeout**: SELECTED → SUBMITTING_ENTRY → NO_POSITION{funding_event_timeout}.
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRiskGate } from '../../src/risk/gate.js'
import {
  driveToTimeout,
  driveToTpExit,
  INTENT_ID,
  S6_RUNTIME_CONFIG,
  SETTLE_RATE,
  START_MS,
} from '../helpers/s6-scenario.js'
import { checkWalDbConsistency, expectTerminal, expectTradeRecordShape } from './assertions.js'
import { createE2eContext, type E2eContext } from './harness.js'

let ctx: E2eContext

/** S6's 540-USD net notional needs a widened risk gate vs the harness default cap. */
const RISK_GATE = createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 10_000 })

beforeAll(async () => {
  ctx = await createE2eContext()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

describe('strategy S6 end-to-end through a full instance', () => {
  it('tp_hit path: CLOSED/tp_hit, five WAL transitions forwarded, settledRatePercent recorded', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS, strategyConfig: S6_RUNTIME_CONFIG, riskGate: RISK_GATE })

    await driveToTpExit(inst.harness)

    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'tp_hit' }),
      { timeout: 5000, interval: 25 },
    )

    await inst.forwarder.tick()

    const dbRows = await inst.walRows(INTENT_ID)
    expect(dbRows).toEqual([
      { from_state: 'SELECTED', to_state: 'SUBMITTING_ENTRY' },
      { from_state: 'SUBMITTING_ENTRY', to_state: 'MONITORING' },
      { from_state: 'MONITORING', to_state: 'EXITING' },
      { from_state: 'EXITING', to_state: 'CLOSED' },
    ])
    expect(checkWalDbConsistency(inst.localWal(INTENT_ID), dbRows, INTENT_ID).consistent).toBe(true)
    expectTradeRecordShape(await inst.intentRow(INTENT_ID))

    // The settled |F| the OCO was priced off is threaded onto the MONITORING WAL record (`07` §2 step 4).
    const monitoring = inst.localWal(INTENT_ID).find((r) => r.toState === 'MONITORING')
    expect((monitoring?.payload as { settledRatePercent?: number } | undefined)?.settledRatePercent).toBeCloseTo(
      SETTLE_RATE,
      12,
    )
  })

  it('funding_event_timeout path: SUBMITTING_ENTRY → NO_POSITION, forwarded consistently', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS, strategyConfig: S6_RUNTIME_CONFIG, riskGate: RISK_GATE })

    await driveToTimeout(inst.harness)

    await vi.waitFor(
      async () =>
        expectTerminal(await inst.intentRow(INTENT_ID), { state: 'NO_POSITION', errorCode: 'funding_event_timeout' }),
      { timeout: 5000, interval: 25 },
    )

    await inst.forwarder.tick()

    const dbRows = await inst.walRows(INTENT_ID)
    expect(dbRows).toEqual([
      { from_state: 'SELECTED', to_state: 'SUBMITTING_ENTRY' },
      { from_state: 'SUBMITTING_ENTRY', to_state: 'NO_POSITION' },
    ])
    expect(checkWalDbConsistency(inst.localWal(INTENT_ID), dbRows, INTENT_ID).consistent).toBe(true)
  })
})
