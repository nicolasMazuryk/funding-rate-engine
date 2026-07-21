/**
 * E2E tier (task 0300; `17` §4) — Strategy S1-WS through a full instance: scheduler →
 * finder → preflight → intent → the `funding_fee_event` gate → real Postgres + real local
 * WAL, on the virtual clock + sim venue. `bootInstance` composes `buildSkeletonEngine`,
 * which auto-selects the S1-WS module + `funding_fee_event` handler from the `s1-ws`
 * strategy id, so this file drives the shared WS-event happy path and asserts the S1-WS DoD:
 *
 *  - CLOSED with `exit_reason = funding_fee_event`;
 *  - the four WAL transitions forwarded consistently to `intent_wal`;
 *  - `funding_received = true` recorded on the MONITORING WAL record (`00_globals.md` §3.1).
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveToWsFundingExit, S1_WS_RUNTIME_CONFIG } from '../helpers/s1-ws-scenario.js'
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

describe('strategy S1-WS end-to-end through a full instance', () => {
  it('happy path: CLOSED/funding_fee_event, four WAL transitions forwarded, funding_received recorded', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS, strategyConfig: S1_WS_RUNTIME_CONFIG })

    driveToWsFundingExit(inst.harness)

    // Current-state projection is written via un-awaited upserts — wait for CLOSED.
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'funding_fee_event' }),
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

    const monitoring = inst.localWal(INTENT_ID).find((r) => r.toState === 'MONITORING')
    expect((monitoring?.payload as { fundingReceived?: boolean } | undefined)?.fundingReceived).toBe(true)
  })
})
