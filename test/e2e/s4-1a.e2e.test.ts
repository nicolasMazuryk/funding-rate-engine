/**
 * E2E tier (task 0330; `17` §4) — Strategy S4.1a through a full instance: scheduler → finder →
 * preflight → ladder intent → engine-side conditional SL + reduce-only market close → real Postgres
 * + real local WAL, on the virtual clock + sim venue. `bootInstance` composes `buildSkeletonEngine`,
 * which auto-selects the S4.1a module + ladder `sl_tp_deadline` handler from the `s4-1a` strategy id,
 * so this file drives the partial-fill sl_hit path and asserts the S4.1a DoD:
 *
 *  - CLOSED with `exit_reason = sl_hit` after only the top two rungs fill;
 *  - the four WAL transitions forwarded consistently to `intent_wal`.
 *
 * The 300-USD ladder needs the risk gate widened past the harness default (100). Needs Docker
 * Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRiskGate } from '../../src/risk/gate.js'
import { driveToPartialSlExit, S4_1A_RUNTIME_CONFIG } from '../helpers/s4-1a-scenario.js'
import { INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { checkWalDbConsistency, expectTerminal, expectTradeRecordShape } from './assertions.js'
import { createE2eContext, type E2eContext } from './harness.js'

let ctx: E2eContext

beforeAll(async () => {
  ctx = await createE2eContext()
})

afterAll(async () => {
  await ctx.close()
})

beforeEach(async () => {
  await ctx.reset()
})

describe('strategy S4.1a end-to-end through a full instance', () => {
  it('partial-fill sl_hit path: CLOSED/sl_hit, four WAL transitions forwarded', async () => {
    const inst = ctx.bootInstance({
      startMs: START_MS,
      strategyConfig: S4_1A_RUNTIME_CONFIG,
      riskGate: createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 1_000 }),
    })

    driveToPartialSlExit(inst.harness)

    // Current-state projection is written via un-awaited upserts — wait for CLOSED.
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'sl_hit' }),
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
  })
})
