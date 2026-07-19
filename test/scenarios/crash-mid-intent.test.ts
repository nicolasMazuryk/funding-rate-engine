/**
 * Scenario: **crash mid-intent** (`13` §6 — WAL replay → deterministic recovery). Drive
 * a triggered intent to `MONITORING`, simulate a process crash (drop the engine's
 * in-memory state; keep the WAL file + sim venue), restart against the same WAL/venue,
 * and confirm the intent resumes from the WAL and closes with no duplicate entry order.
 *
 * Reuses the proven crash/restart sequence via {@link ./crash-helper.js} and the shared
 * {@link ../helpers/skeleton-scenario.js} timeline — the same path the unit-tier
 * `crash-recovery.test.ts` drives, now expressed as a scenario.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { harnessPool } from '../helpers/harness-pool.js'
import { spyEntryOrders } from '../helpers/sim-spies.js'
import { DEADLINE_TS, driveToEntry, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'
import { crash, restart } from './crash-helper.js'

let tmp: TempDir
let walPath: string
let clock: VirtualClock
let bus: EventBus
let sim: SimExchange
const pool = harnessPool()

beforeEach(() => {
  tmp = tempDir('crash-scenario-')
  walPath = tmp.walPath
  clock = createVirtualClock(START_MS)
  bus = createEventBus()
  sim = createSimExchange(clock, bus)
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

function build(exchange: SimExchange): SkeletonHarness {
  return pool.track(buildSkeletonEngine({ walPath, clock, bus, exchange }))
}

describe('scenario: crash mid-intent', () => {
  it('resumes a MONITORING intent from the WAL and closes with no duplicate entry order', async () => {
    const spy = spyEntryOrders(sim)

    const engineA = build(spy.exchange)
    driveToEntry(engineA) // entry fills → MONITORING, WAL carries the deadline
    expect(engineA.engine.intentState(INTENT_ID)).toBe('MONITORING')

    crash(engineA)

    const engineB = pool.track(await restart({ walPath, clock, bus, exchange: spy.exchange }))
    expect(engineB.engine.intentState(INTENT_ID)).toBe('MONITORING')

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(spy.count()).toBe(1) // one entry-leg order across both engines
  })
})
