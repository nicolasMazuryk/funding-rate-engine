/**
 * Crash recovery — S2's deep `MONITORING` snapshot respawn (task 0370 decision #2, the DoD:
 * "S2 fully re-spawned from persisted `P_low`"). Distinct from the two-state skeleton crash
 * tests (`test/unit/core/runtime/crash-recovery.test.ts`, S1's `timed` handler, which owns no
 * resting legs): S2's retracement tracker is the one handler with a durable snapshot
 * (`tracker_snapshots`), so recovery must restore its `P_low`/rotating-TP state instead of a
 * blind re-arm (which would duplicate the resting SL and reset the TP's attempt counter).
 *
 * The repo is intentionally the SAME instance across the simulated crash (unlike the
 * skeleton tests' `{ fresh: true }`) — `tracker_snapshots` already lives in the durable store
 * (Postgres in production); only the engine's in-memory process state and the local WAL file
 * are what a real crash discards, and the WAL file survives here too (same path).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { RetracementHandler, RetracementSnapshot } from '../../src/core/intent/exit-policies/retracement.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import { recoveredFromWal } from '../../src/core/runtime/engine.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import { createInMemoryRepo, type InMemoryRepo } from '../helpers/in-memory-repo.js'
import { driveToTrailing, S2_RUNTIME_CONFIG } from '../helpers/s2-scenario.js'
import { BTC, INTENT_ID, SETTLE_TS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'
import { crash } from '../scenarios/crash-helper.js'

const RETRACEMENT_KIND = 'sl_tp_deadline_retracement_funding_event'

let tmp: TempDir
let walPath: string
let clock: VirtualClock
let bus: EventBus
let sim: SimExchange
const pool = harnessPool()

function build(repo: InMemoryRepo): SkeletonHarness {
  return pool.track(
    buildSkeletonEngine({ walPath, clock, bus, exchange: sim, repo, strategyConfig: S2_RUNTIME_CONFIG }),
  )
}

beforeEach(() => {
  tmp = tempDir('crash-s2-test-')
  walPath = tmp.walPath
  clock = createVirtualClock(0)
  bus = createEventBus()
  sim = createSimExchange(clock, bus)
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('crash recovery — S2 deep MONITORING snapshot respawn', () => {
  it('restores the trailing P_low from the durable tracker snapshot, without re-placing the SL', async () => {
    const repo = createInMemoryRepo()
    const engineA = build(repo)

    driveToTrailing(engineA)
    clock.advanceTo(SETTLE_TS + 1_000)
    sim.setPrice(BTC.symbol, 59_800) // first trailing low → places the TP, forces a snapshot write
    clock.advanceTo(SETTLE_TS + 2_000)
    sim.setPrice(BTC.symbol, 59_700) // a lower low → re-places the TP (throttle window elapsed)

    const before = await repo.loadTrackerSnapshots?.()
    expect(before).toHaveLength(1)
    const beforeSnapshot = before?.[0]
    expect(beforeSnapshot?.intentId).toBe(INTENT_ID)
    const trackerBefore = (beforeSnapshot?.snapshot as RetracementSnapshot | undefined)?.tracker
    expect(trackerBefore?.phase).toBe('trailing')
    expect(trackerBefore?.pLow).toBe(59_700)

    crash(engineA)

    // Same repo (the durable store survives a real crash); same WAL/venue/clock/bus.
    const engineB = build(repo)
    const placedByB: string[] = []
    const rawPlace = sim.placeOrder.bind(sim)
    sim.placeOrder = (req) => {
      placedByB.push(req.clientOrderId)
      return rawPlace(req)
    }

    const recovered = recoveredFromWal(engineB.wal.readAll())
    expect(recovered.map((r) => [r.intentId, r.state])).toEqual([[INTENT_ID, 'MONITORING']])
    const snapshots = (await repo.loadTrackerSnapshots?.()) ?? []
    await engineB.engine.recover(recovered, snapshots)

    // No blind re-arm: the SL/TP already resting on the venue are NOT re-placed.
    expect(placedByB).toEqual([])

    // The fresh handler instance's tracker was restored — same P_low as before the crash.
    const handler = engineB.exitPolicyRegistry.get(RETRACEMENT_KIND) as RetracementHandler
    const restored = handler.serialize().find((s) => s.intentId === INTENT_ID)
    expect(restored?.tracker.phase).toBe('trailing')
    expect(restored?.tracker.pLow).toBe(59_700)

    // The tracker is live post-recovery, not just restored data: a further lower low (throttle
    // window elapsed) re-places the TP.
    clock.advanceTo(SETTLE_TS + 3_000)
    sim.setPrice(BTC.symbol, 59_600)
    expect(placedByB.some((id) => id.includes('-tp-'))).toBe(true)
  })
})
