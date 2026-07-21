/**
 * E2E tier (task 0280; `17` §4) — Strategy S1 through a full instance: scheduler →
 * finder → preflight → intent → the real `timed` exit → real Postgres + real local
 * WAL, on the virtual clock + sim venue. `bootInstance` composes `buildSkeletonEngine`,
 * which now defaults to the real S1 module + `TIMED_HANDLER`, so this file just drives
 * the shared scenario and asserts the S1 DoD:
 *
 *  - CLOSED with `exit_reason = timed`;
 *  - the four WAL transitions forwarded consistently to `intent_wal`;
 *  - `funding_received = true` recorded on the MONITORING WAL record (`00_globals.md` §3.1).
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INTENT_ID, runSkeletonScenario, START_MS } from '../helpers/skeleton-scenario.js'
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

describe('strategy S1 end-to-end through a full instance', () => {
  it('happy path: CLOSED/timed, four WAL transitions forwarded, funding_received recorded', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS })

    runSkeletonScenario(inst.harness)

    // Current-state projection is written via un-awaited upserts — wait for CLOSED.
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
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

    // funding_received is recorded in the local-WAL MONITORING payload (not yet an
    // `intents` column — that + a trades table are 0360/0390). Entry filled before
    // T_settle on the happy path → true.
    const monitoring = inst.localWal(INTENT_ID).find((r) => r.toState === 'MONITORING')
    expect((monitoring?.payload as { fundingReceived?: boolean } | undefined)?.fundingReceived).toBe(true)
  })
})
