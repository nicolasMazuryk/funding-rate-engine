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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EventBus } from '../../src/core/ports/bus.js'
import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import { BTC, DEADLINE_TS, ENTRY_TS, ETH, SCAN_TS, START_MS } from '../helpers/skeleton-scenario.js'
import { crash, restart } from './crash-helper.js'

const INTENT_ID = `${BTC.symbol}-${ENTRY_TS}`

let dir: string
let walPath: string
let clock: VirtualClock
let bus: EventBus
let sim: SimExchange
const harnesses: SkeletonHarness[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crash-scenario-'))
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

function build(exchange: SimExchange): SkeletonHarness {
  const h = buildSkeletonEngine({ walPath, clock, bus, exchange })
  harnesses.push(h)
  return h
}

describe('scenario: crash mid-intent', () => {
  it('resumes a MONITORING intent from the WAL and closes with no duplicate entry order', async () => {
    let entryOrders = 0
    const counting: SimExchange = {
      ...sim,
      placeOrder(req: OrderRequest): Promise<OrderAck> {
        if (req.clientOrderId.includes('-entry-')) entryOrders += 1
        return sim.placeOrder(req)
      },
    }

    const engineA = build(counting)
    sim.setPrice(BTC.symbol, BTC.price)
    sim.setPrice(ETH.symbol, ETH.price)
    sim.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
    sim.setPredictedFunding(ETH.symbol, ETH.predicted, SCAN_TS)
    engineA.scheduler.start()
    clock.advanceTo(SCAN_TS)
    clock.advanceTo(ENTRY_TS) // entry fills → MONITORING, WAL carries the deadline
    expect(engineA.engine.intentState(INTENT_ID)).toBe('MONITORING')

    crash(engineA)

    const engineB = await restart({ walPath, clock, bus, exchange: counting })
    harnesses.push(engineB)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('MONITORING')

    clock.advanceTo(DEADLINE_TS)
    expect(engineB.engine.intentState(INTENT_ID)).toBe('CLOSED')
    expect(entryOrders).toBe(1) // one entry-leg order across both engines
  })
})
