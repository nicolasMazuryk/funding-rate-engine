/**
 * E2E tier (task 0270; `17` §4) — the walking skeleton through a full instance:
 * scheduler → finder → preflight → intent → execution → real Postgres + real
 * local WAL, on the virtual clock + sim venue. Two proving scenarios (happy path,
 * kill-switch-paused) plus the WAL↔DB consistency demonstration (DoD #2). These
 * supersede the old `test/integration/skeleton-e2e.test.ts`.
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 * Excluded from the default `npm run verify`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { pausedKillSwitch } from '../helpers/kill-switch.js'
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

describe('skeleton end-to-end through a full instance', () => {
  it('happy path: persists CLOSED/timed and forwards the four WAL transitions consistently', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS })

    runSkeletonScenario(inst.harness)

    // Current-state projection is written via un-awaited upserts — wait for CLOSED.
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      {
        timeout: 5000,
        interval: 25,
      },
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

  it('kill-switch paused: places no order and persists one ABORTED/kill_switch intent', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS, killSwitch: pausedKillSwitch() })
    const placeOrder = vi.spyOn(inst.harness.exchange, 'placeOrder')

    runSkeletonScenario(inst.harness)

    expect(placeOrder).not.toHaveBeenCalled()
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'ABORTED', errorCode: 'kill_switch' }),
      { timeout: 5000, interval: 25 },
    )

    await inst.forwarder.tick()
    expect(await inst.walRows(INTENT_ID)).toEqual([{ from_state: 'SELECTED', to_state: 'ABORTED' }])
  })

  it('WAL↔DB consistency check detects a skipped forwarder, then passes once it ticks (DoD #2)', async () => {
    const inst = ctx.bootInstance({ startMs: START_MS })

    runSkeletonScenario(inst.harness)
    await vi.waitFor(
      async () => expectTerminal(await inst.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      {
        timeout: 5000,
        interval: 25,
      },
    )

    // Forwarder NOT ticked: the local WAL has four transitions, `intent_wal` has zero.
    const local = inst.localWal(INTENT_ID)
    const before = checkWalDbConsistency(local, await inst.walRows(INTENT_ID), INTENT_ID)
    expect(before.consistent).toBe(false)
    expect(before.local).toHaveLength(4)
    expect(before.missing).toHaveLength(4)

    // Tick, and the same check now passes.
    await inst.forwarder.tick()
    expect(checkWalDbConsistency(local, await inst.walRows(INTENT_ID), INTENT_ID).consistent).toBe(true)
  })
})
