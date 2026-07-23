/**
 * Crash-recovery tests at two intent states (task 0090; `14` §5, minimal).
 *
 * A "crash" is simulated by discarding an engine's in-memory state (dispose +
 * drop) while the WAL file and the sim venue survive — exactly what persists
 * across a real process kill. A fresh engine reopens the same WAL path and the
 * same venue, rebuilds its recoverable intents from `recoveredFromWal(...)`, and
 * completes the slice deterministically with no duplicate order submission.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../../../src/core/events/bus.js'
import type { EventBus } from '../../../../src/core/ports/bus.js'
import { recoveredFromWal } from '../../../../src/core/runtime/engine.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../../../helpers/build-skeleton-engine.js'
import { harnessPool } from '../../../helpers/harness-pool.js'
import { createInMemoryRepo } from '../../../helpers/in-memory-repo.js'
import { hangEntryOrders, hangExitOrders, spyEntryOrders } from '../../../helpers/sim-spies.js'
import { BTC, DEADLINE_TS, driveToEntry, INTENT_ID, START_MS } from '../../../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../../../helpers/temp-dir.js'
import { crash } from '../../../scenarios/crash-helper.js'

let tmp: TempDir
let walPath: string
let clock: VirtualClock
let bus: EventBus
let sim: SimExchange
const pool = harnessPool()

function build(exchange: SimExchange, opts: { fresh?: boolean } = {}): SkeletonHarness {
  return pool.track(
    buildSkeletonEngine({ walPath, clock, bus, exchange, repo: opts.fresh ? createInMemoryRepo() : undefined }),
  )
}

beforeEach(() => {
  tmp = tempDir('crash-test-')
  walPath = tmp.walPath
  clock = createVirtualClock(START_MS)
  bus = createEventBus()
  sim = createSimExchange(clock, bus)
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('crash recovery — Scenario A: after SUBMITTING_ENTRY WAL append, before fill', () => {
  it('re-submits the same clientOrderId (no duplicate) and completes to CLOSED', async () => {
    // Engine A's entry placeOrder hangs forever — WAL records SUBMITTING_ENTRY,
    // but the venue never sees the order and never fills.
    const engineA = build(hangEntryOrders(sim))
    driveToEntry(engineA)
    expect(engineA.engine.intentState(INTENT_ID)).toBe('SUBMITTING_ENTRY')
    expect(await sim.getPositions()).toEqual([]) // nothing filled

    crash(engineA)

    // Engine B: same WAL path, same (real) venue, fresh repo.
    const engineB = build(sim, { fresh: true })
    const recovered = recoveredFromWal(engineB.wal.readAll())
    expect(recovered.map((r) => [r.intentId, r.state])).toEqual([[INTENT_ID, 'SUBMITTING_ENTRY']])

    await engineB.engine.recover(recovered) // getOrder throws → re-submit → fills for real

    // Exactly one position at the expected qty — the re-submit did not duplicate.
    const positions = await sim.getPositions()
    expect(positions).toEqual([{ symbol: BTC.symbol, side: 'long', qty: 0.001, entryPrice: BTC.price }])

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(await sim.getPositions()).toEqual([]) // exit flattened it
  })
})

describe('crash recovery — Scenario B: during MONITORING', () => {
  it('re-schedules the deadline from the WAL, does not re-enter, and closes with no duplicate entry order', async () => {
    const spy = spyEntryOrders(sim)

    const engineA = build(spy.exchange)
    driveToEntry(engineA) // real entry fill → MONITORING, WAL carries tDeadlineMs
    expect(engineA.engine.intentState(INTENT_ID)).toBe('MONITORING')

    crash(engineA)

    const engineB = build(spy.exchange, { fresh: true })
    const recovered = recoveredFromWal(engineB.wal.readAll())
    expect(recovered.map((r) => [r.intentId, r.state])).toEqual([[INTENT_ID, 'MONITORING']])
    expect(recovered[0]?.tDeadlineMs).toBe(DEADLINE_TS)

    await engineB.engine.recover(recovered) // MONITORING branch: no placeOrder, re-schedule deadline

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(spy.count()).toBe(1) // one entry-leg order across both engines
  })
})

describe('crash recovery — Scenario C: after MONITORING→EXITING WAL append, before exit fill', () => {
  it('re-issues the same clientOrderId (no duplicate) and completes to CLOSED with the recovered exitReason', async () => {
    // Engine A's exit-leg placeOrder hangs forever — WAL records EXITING (carrying the
    // exitReason, `fireExit`), but the venue never sees the reduce-only close.
    const engineA = build(hangExitOrders(sim))
    driveToEntry(engineA)
    expect(engineA.engine.intentState(INTENT_ID)).toBe('MONITORING')

    clock.advanceTo(DEADLINE_TS) // fires the `timed` exit; the leg hangs
    expect(engineA.engine.intentState(INTENT_ID)).toBe('EXITING')
    expect(await sim.getPositions()).toEqual([{ symbol: BTC.symbol, side: 'long', qty: 0.001, entryPrice: BTC.price }])

    crash(engineA)

    // Engine B: same WAL path, same (real) venue, fresh repo.
    const engineB = build(sim, { fresh: true })
    const recovered = recoveredFromWal(engineB.wal.readAll())
    expect(recovered.map((r) => [r.intentId, r.state])).toEqual([[INTENT_ID, 'EXITING']])
    expect(recovered[0]?.exitReason).toBe('timed') // rode the EXITING transition, not just CLOSED

    await engineB.engine.recover(recovered) // getOrder throws → re-issue the exit → fills for real

    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    // Exactly flat — the re-issue did not duplicate the reduce-only close.
    expect(await sim.getPositions()).toEqual([])
  })
})
