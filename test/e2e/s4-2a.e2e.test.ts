/**
 * E2E tier (task 0340; `17` §4) — Strategy S4.2a through a full instance: scheduler → finder →
 * preflight → single-limit intent → engine-side conditional SL + venue `expireAt` → real Postgres +
 * real local WAL, on the virtual clock + sim venue. `bootInstance` composes `buildSkeletonEngine`,
 * which auto-selects the S4.2a module + ladder `sl_tp_deadline` handler from the `s4-2a` strategy id,
 * so this file drives the distinctive `limit_expired` no-fill path and asserts the S4.2a DoD:
 *
 *  - NO_POSITION with `error_code = limit_expired` after the lone limit never fills (`06` §2 R5);
 *  - the two WAL transitions forwarded consistently to `intent_wal`.
 *
 * The 300-USD limit needs the risk gate widened past the harness default (100). Needs Docker
 * Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRiskGate } from '../../src/risk/gate.js'
import { driveToLimitExpired, S4_2A_RUNTIME_CONFIG } from '../helpers/s4-2a-scenario.js'
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

describe('strategy S4.2a end-to-end through a full instance', () => {
  it('limit_expired path: NO_POSITION/limit_expired, two WAL transitions forwarded', async () => {
    const inst = ctx.bootInstance({
      startMs: START_MS,
      strategyConfig: S4_2A_RUNTIME_CONFIG,
      riskGate: createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 1_000 }),
    })

    driveToLimitExpired(inst.harness)

    // Current-state projection is written via un-awaited upserts — wait for NO_POSITION.
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'NO_POSITION', errorCode: 'limit_expired' }),
      { timeout: 5000, interval: 25 },
    )

    await inst.forwarder.tick()

    const dbRows = await inst.walRows(INTENT_ID)
    expect(dbRows).toEqual([
      { from_state: 'SELECTED', to_state: 'SUBMITTING_ENTRY' },
      { from_state: 'SUBMITTING_ENTRY', to_state: 'NO_POSITION' },
    ])
    expect(checkWalDbConsistency(inst.localWal(INTENT_ID), dbRows, INTENT_ID).consistent).toBe(true)
    expectTradeRecordShape(await inst.intentRow(INTENT_ID))
  })
})
