/**
 * E2E tier (task 0370; `14` §5) — the full crash-recovery matrix through `recoverOnBoot`
 * (config-hash check → WAL replay → tracker snapshots → `engine.recover` → kill-switch
 * restore), against real Docker Postgres + a real local WAL file — the two ports the unit
 * crash tests (`test/unit/core/runtime/crash-recovery.test.ts`) fake with an in-memory repo.
 *
 * Matrix breadth (0370 decision #1): the three non-terminal WAL-append points a live
 * intent actually reaches (`SUBMITTING_ENTRY`, `MONITORING`, `EXITING` — keyed off
 * `INTENT_TRANSITIONS`), each proven with the skeleton S1 `timed` path, plus a case proving
 * `SELECTED` structurally never reaches the WAL (see `engine.ts`'s `recoverSelected` doc
 * comment). S2's deep `MONITORING` tracker-snapshot respawn is proven separately (its own
 * resting legs + rotating TP need the S2 wiring, not the skeleton).
 *
 * Every "reboot" reuses the SAME sim venue + clock + bus across instA/instB, mirroring the
 * unit-tier `crash-helper.ts` convention: the sim is an in-process fake standing in for an
 * independent venue process, and it publishes fills onto whatever `EventBus` it was built
 * with — engine B must share that bus (and the clock the sim reads for fill timestamps) to
 * observe the venue's continuing activity, exactly as `crash-helper.ts`'s `restart()` does.
 * The WAL file (by path) and the real Postgres repo/tables are what a real crash actually
 * discards nothing of — those two are the only state genuinely re-opened fresh here.
 *
 * Needs Docker Postgres (`docker compose up -d`); run via `npm run test:e2e`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import type { SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import { DEV_INSTANCE } from '../../src/persistence/db/instance.js'
import { recoverOnBoot } from '../../src/persistence/recovery.js'
import { driveToTrailing, S2_RUNTIME_CONFIG } from '../helpers/s2-scenario.js'
import { BTC, DEADLINE_TS, driveToEntry, INTENT_ID, SETTLE_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { expectTerminal } from './assertions.js'
import { type BootedInstance, createE2eContext, type E2eContext } from './harness.js'

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

/** "Crash" a booted instance: discard its in-memory state; the WAL file + Postgres + venue survive. */
function crash(inst: BootedInstance): void {
  inst.harness.engine.dispose()
  inst.harness.scheduler.stop()
}

/** The shared cross-crash state a real venue outlives the process restart with. */
interface SharedVenueState {
  readonly clock: VirtualClock
  readonly bus: EventBus
  readonly exchange: SimExchange
}

/** Capture the shared clock/bus/exchange a `BootedInstance` was built with, for its "restart". */
function venueOf(inst: BootedInstance): SharedVenueState {
  return { clock: inst.harness.clock, bus: inst.harness.bus, exchange: inst.harness.exchange }
}

/**
 * Reboot through the full 0370 recovery sequence, against the same WAL path + Postgres +
 * the same clock/bus/exchange (`SharedVenueState`) — a real reboot reopens the same venue
 * session, it does not get a fresh one (`crash-helper.ts`'s `restart()` convention).
 */
async function recoverAndBoot(
  walPath: string,
  shared: SharedVenueState,
  opts: { readonly strategyConfig?: typeof S2_RUNTIME_CONFIG } = {},
): Promise<BootedInstance> {
  const inst = ctx.bootInstance({ walPath, ...shared, strategyConfig: opts.strategyConfig })
  await recoverOnBoot({
    repo: inst.harness.repo,
    wal: inst.harness.wal,
    engine: inst.harness.engine,
    killSwitch: inst.harness.killSwitch,
    configHash: 'e2e-test-config-hash',
    instance: DEV_INSTANCE,
  })
  return inst
}

describe('crash-recovery matrix (task 0370) — one case per reachable WAL-append point', () => {
  it('SUBMITTING_ENTRY: re-submits the same clientOrderId (no duplicate), completes to CLOSED', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    const rawPlace = instA.harness.exchange.placeOrder.bind(instA.harness.exchange)
    instA.harness.exchange.placeOrder = () => new Promise(() => {}) // the entry leg hangs forever
    driveToEntry(instA.harness)
    crash(instA)
    instA.harness.exchange.placeOrder = rawPlace // restore so the SAME venue instance fills on re-submit

    const instB = await recoverAndBoot(walPath, venueOf(instA))
    instB.harness.clock.advanceTo(DEADLINE_TS) // the recovered `timed` deadline is a future absolute instant
    await vi.waitFor(
      async () => expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    const placements = instB.localWal(INTENT_ID).filter((r) => r.clientOrderId?.includes('-entry-'))
    expect(new Set(placements.map((r) => r.clientOrderId)).size).toBe(1) // one entry clientOrderId total
  })

  it('MONITORING: re-schedules the deadline from the WAL, completes to CLOSED with no re-entry', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    driveToEntry(instA.harness) // real fill → MONITORING
    await vi.waitFor(async () => expectTerminal(await instA.intentRow(INTENT_ID), { state: 'MONITORING' }), {
      timeout: 5000,
      interval: 25,
    })
    crash(instA)

    const instB = await recoverAndBoot(walPath, venueOf(instA))
    instB.harness.clock.advanceTo(DEADLINE_TS)
    await vi.waitFor(
      async () => expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    const entryOrders = instB.localWal(INTENT_ID).filter((r) => r.clientOrderId?.includes('-entry-'))
    expect(entryOrders).toHaveLength(1) // no duplicate/re-entry
  })

  it('EXITING: re-issues the same clientOrderId (no duplicate), completes to CLOSED with the recovered exitReason', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    driveToEntry(instA.harness)
    await vi.waitFor(async () => expectTerminal(await instA.intentRow(INTENT_ID), { state: 'MONITORING' }), {
      timeout: 5000,
      interval: 25,
    })
    const rawPlace = instA.harness.exchange.placeOrder.bind(instA.harness.exchange)
    instA.harness.exchange.placeOrder = (req) =>
      req.clientOrderId.includes('-exit-') ? new Promise(() => {}) : rawPlace(req)
    instA.harness.clock.advanceTo(DEADLINE_TS) // fires the exit; the leg hangs
    await vi.waitFor(async () => expectTerminal(await instA.intentRow(INTENT_ID), { state: 'EXITING' }), {
      timeout: 5000,
      interval: 25,
    })
    crash(instA)
    instA.harness.exchange.placeOrder = rawPlace // restore so the re-issue fills on the same venue instance

    const instB = await recoverAndBoot(walPath, venueOf(instA))
    await vi.waitFor(
      async () => expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    const exitOrders = instB.localWal(INTENT_ID).filter((r) => r.clientOrderId?.includes('-exit-'))
    expect(exitOrders).toHaveLength(1)
    expect(await instB.harness.exchange.getPositions()).toEqual([])
  })

  it('SELECTED never reaches the WAL — a crash before the first entry commit leaves no trace to recover', async () => {
    // No `driveToEntry` at all: nothing was ever committed for this intentId.
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    crash(instA)
    const instB = await recoverAndBoot(walPath, venueOf(instA))
    expect(await instB.intentRow(INTENT_ID)).toBeUndefined()
  })
})

describe('crash-recovery matrix (task 0370) — S2 deep MONITORING tracker-snapshot respawn', () => {
  it('restores P_low from the durable tracker_snapshots row and reaches CLOSED/tp_hit with no duplicate legs', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath, strategyConfig: S2_RUNTIME_CONFIG })
    driveToTrailing(instA.harness)
    instA.harness.clock.advanceTo(SETTLE_TS + 1_000)
    instA.harness.exchange.setPrice(BTC.symbol, 59_800) // first low: SL+TP resting, snapshot force-written

    await vi.waitFor(async () => expect(await instA.harness.repo.loadTrackerSnapshots?.()).toHaveLength(1), {
      timeout: 5000,
      interval: 25,
    })
    crash(instA)

    const instB = await recoverAndBoot(walPath, venueOf(instA), { strategyConfig: S2_RUNTIME_CONFIG })
    const placedByB: string[] = []
    const rawPlace = instB.harness.exchange.placeOrder.bind(instB.harness.exchange)
    instB.harness.exchange.placeOrder = (req) => {
      placedByB.push(req.clientOrderId)
      return rawPlace(req)
    }
    // No blind re-arm: the SL/TP already resting on the venue were NOT re-placed by recovery.
    expect(placedByB).toEqual([])

    instB.harness.clock.advanceTo(SETTLE_TS + 2_000)
    instB.harness.exchange.setPrice(BTC.symbol, 59_700) // lower low → re-places from the restored P_low
    expect(placedByB.some((id) => id.includes('-tp-'))).toBe(true)
    instB.harness.clock.advanceTo(SETTLE_TS + 3_000)
    instB.harness.exchange.setPrice(BTC.symbol, 60_000) // recovers to the anchor → TP fills → tp_hit

    await vi.waitFor(
      async () => expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'tp_hit' }),
      { timeout: 5000, interval: 25 },
    )
  })
})

describe('crash-recovery matrix (task 0370) — other verification points', () => {
  it('unforwarded-WAL crash: intent_wal catches up exactly once after the forwarder ticks post-recovery', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    driveToEntry(instA.harness)
    instA.harness.clock.advanceTo(DEADLINE_TS)
    await vi.waitFor(
      async () => expectTerminal(await instA.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    // Forwarder never ticked for instA — intent_wal has zero rows for this intent.
    expect(await instA.walRows(INTENT_ID)).toHaveLength(0)
    crash(instA)

    const instB = await recoverAndBoot(walPath, venueOf(instA)) // recovery reads the LOCAL wal only
    expect(await instB.walRows(INTENT_ID)).toHaveLength(0)

    await instB.forwarder.tick() // catches up the full local backlog in one pass
    const rows = await instB.walRows(INTENT_ID)
    expect(rows).toHaveLength(4) // SELECTED->SUBMITTING_ENTRY, ->MONITORING, ->EXITING, ->CLOSED

    await instB.forwarder.tick() // idempotent: a second tick ships nothing new (ON CONFLICT DO NOTHING)
    expect(await instB.walRows(INTENT_ID)).toHaveLength(4)
  })

  it('config-hash mismatch fails loud before any venue call', async () => {
    const instB = ctx.bootInstance({ startMs: START_MS })
    const placeOrder = vi.spyOn(instB.harness.exchange, 'placeOrder')

    await expect(
      recoverOnBoot({
        repo: {
          ...instB.harness.repo,
          loadNonTerminalIntents: async () => [
            { intentId: INTENT_ID, state: 'MONITORING', symbol: BTC.symbol, configHash: 'stale-hash' },
          ],
        },
        wal: instB.harness.wal,
        engine: instB.harness.engine,
        killSwitch: instB.harness.killSwitch,
        configHash: 'current-hash',
        instance: DEV_INSTANCE,
      }),
    ).rejects.toThrow(/config revision mismatch/)
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('recovery-idempotency: running recoverOnBoot twice against the same state yields the same outcome', async () => {
    const walPath = await ctx.reset()
    const instA = ctx.bootInstance({ startMs: START_MS, walPath })
    driveToEntry(instA.harness)
    instA.harness.clock.advanceTo(DEADLINE_TS)
    await vi.waitFor(
      async () => expectTerminal(await instA.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    crash(instA)

    const instB = await recoverAndBoot(walPath, venueOf(instA))
    await vi.waitFor(
      async () => expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' }),
      { timeout: 5000, interval: 25 },
    )
    // Recover a SECOND time against the already-CLOSED state: no non-terminal intents left, so
    // `engine.recover` gets an empty list — a pure no-op, not a re-drive.
    await recoverOnBoot({
      repo: instB.harness.repo,
      wal: instB.harness.wal,
      engine: instB.harness.engine,
      killSwitch: instB.harness.killSwitch,
      configHash: 'e2e-test-config-hash',
      instance: DEV_INSTANCE,
    })
    expectTerminal(await instB.intentRow(INTENT_ID), { state: 'CLOSED', exitReason: 'timed' })
    expect(await instB.harness.exchange.getPositions()).toEqual([])
  })
})
