/**
 * Crash-recovery tests at two intent states (task 0090; `14` §5, minimal).
 *
 * A "crash" is simulated by discarding an engine's in-memory state (dispose +
 * drop) while the WAL file and the sim venue survive — exactly what persists
 * across a real process kill. A fresh engine reopens the same WAL path and the
 * same venue, rebuilds its recoverable intents from `recoveredFromWal(...)`, and
 * completes the slice deterministically with no duplicate order submission.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../../../src/core/events/bus.js'
import type { EventBus } from '../../../../src/core/ports/bus.js'
import type { OrderAck, OrderRequest } from '../../../../src/core/ports/exchange-adapter.js'
import { recoveredFromWal } from '../../../../src/core/runtime/engine.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../../../helpers/build-skeleton-engine.js'
import { createInMemoryRepo } from '../../../helpers/in-memory-repo.js'
import { BTC, DEADLINE_TS, ENTRY_TS, ETH, SCAN_TS, START_MS } from '../../../helpers/skeleton-scenario.js'

const INTENT_ID = `${BTC.symbol}-${ENTRY_TS}`

let dir: string
let walPath: string
let clock: VirtualClock
let bus: EventBus
let sim: SimExchange
const harnesses: SkeletonHarness[] = []

function build(exchange: SimExchange, opts: { fresh?: boolean } = {}): SkeletonHarness {
  const h = buildSkeletonEngine({ walPath, clock, bus, exchange, repo: opts.fresh ? createInMemoryRepo() : undefined })
  harnesses.push(h)
  return h
}

/** Simulated crash: engine stops reacting and its scan timer is cancelled — the WAL file (already fsync'd) and venue survive. */
function crash(h: SkeletonHarness): void {
  h.engine.dispose()
  h.scheduler.stop()
}

/** Script funding so BTC triggers and ETH does not, then drive scan → entry. */
function driveToEntry(h: SkeletonHarness): void {
  sim.setPrice(BTC.symbol, BTC.price)
  sim.setPrice(ETH.symbol, ETH.price)
  sim.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
  sim.setPredictedFunding(ETH.symbol, ETH.predicted, SCAN_TS)
  h.scheduler.start()
  clock.advanceTo(SCAN_TS)
  clock.advanceTo(ENTRY_TS)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crash-test-'))
  walPath = join(dir, 'instance.wal.jsonl')
  clock = createVirtualClock(START_MS)
  bus = createEventBus()
  sim = createSimExchange(clock, bus)
})

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.engine.dispose()
    h.wal.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('crash recovery — Scenario A: after SUBMITTING_ENTRY WAL append, before fill', () => {
  it('re-submits the same clientOrderId (no duplicate) and completes to CLOSED', async () => {
    // Engine A's entry placeOrder hangs forever — WAL records SUBMITTING_ENTRY,
    // but the venue never sees the order and never fills.
    const hung: SimExchange = {
      ...sim,
      placeOrder(req: OrderRequest): Promise<OrderAck> {
        if (req.clientOrderId.includes('-entry-')) return new Promise<OrderAck>(() => {})
        return sim.placeOrder(req)
      },
    }
    const engineA = build(hung)
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
    expect(positions).toEqual([{ symbol: BTC.symbol, side: 'long', qty: 0.01, entryPrice: BTC.price }])

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(await sim.getPositions()).toEqual([]) // exit flattened it
  })
})

describe('crash recovery — Scenario B: during MONITORING', () => {
  it('re-schedules the deadline from the WAL, does not re-enter, and closes with no duplicate entry order', async () => {
    let entryOrders = 0
    const counting: SimExchange = {
      ...sim,
      placeOrder(req: OrderRequest): Promise<OrderAck> {
        if (req.clientOrderId.includes('-entry-')) entryOrders += 1
        return sim.placeOrder(req)
      },
    }

    const engineA = build(counting)
    driveToEntry(engineA) // real entry fill → MONITORING, WAL carries tDeadlineMs
    expect(engineA.engine.intentState(INTENT_ID)).toBe('MONITORING')

    crash(engineA)

    const engineB = build(counting, { fresh: true })
    const recovered = recoveredFromWal(engineB.wal.readAll())
    expect(recovered.map((r) => [r.intentId, r.state])).toEqual([[INTENT_ID, 'MONITORING']])
    expect(recovered[0]?.tDeadlineMs).toBe(DEADLINE_TS)

    await engineB.engine.recover(recovered) // MONITORING branch: no placeOrder, re-schedule deadline

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(entryOrders).toBe(1) // one entry-leg order across both engines
  })
})
