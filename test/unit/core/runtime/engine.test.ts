import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineEvent, Timer } from '../../../../src/core/events/types.js'
import type { ReconciliationRecord } from '../../../../src/core/runtime/engine.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../../../helpers/build-skeleton-engine.js'
import { createInMemoryRepo, type InMemoryRepo } from '../../../helpers/in-memory-repo.js'
import {
  BTC,
  DEADLINE_TS,
  ENTRY_TS,
  ETH,
  runSkeletonScenario,
  SCAN_TS,
  START_MS,
  triggeredIntentId,
} from '../../../helpers/skeleton-scenario.js'

let dir: string
let walPath: string
const harnesses: SkeletonHarness[] = []

function build(opts: Omit<Parameters<typeof buildSkeletonEngine>[0], 'startMs'>): SkeletonHarness {
  const h = buildSkeletonEngine({ startMs: START_MS, ...opts })
  harnesses.push(h)
  return h
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engine-test-'))
  walPath = join(dir, 'instance.wal.jsonl')
})

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    h.engine.dispose()
    h.wal.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('engine — happy path', () => {
  it('drives SELECTED → … → CLOSED{timed} for the triggering symbol', async () => {
    const repo = createInMemoryRepo()
    const reconciliations: ReconciliationRecord[] = []
    const h = build({ walPath, repo, onReconciliation: (r) => reconciliations.push(r) })

    runSkeletonScenario(h)
    const intentId = triggeredIntentId(h)

    expect(h.engine.intentState(intentId)).toBe('CLOSED')
    // Position closed out (reduce-only exit flattened it).
    expect(await h.exchange.getPositions()).toEqual([])

    const snapshot = (repo as InMemoryRepo).snapshots().find((s) => s.intentId === intentId)
    expect(snapshot?.state).toBe('CLOSED')
    expect(snapshot?.exitReason).toBe('timed')

    // Reconciliation stub ran and matched engine fill vs venue.
    expect(reconciliations).toEqual([
      {
        intentId,
        symbol: BTC.symbol,
        engineQty: h.strategyConfig.entryQty,
        venueQty: h.strategyConfig.entryQty,
        match: true,
      },
    ])
  })

  it('writes exactly the four transition records to the WAL, in order', () => {
    const h = build({ walPath })
    runSkeletonScenario(h)
    const intentId = triggeredIntentId(h)

    const transitions = h.wal.readAll().map((r) => [r.fromState, r.toState])
    expect(transitions).toEqual([
      ['SELECTED', 'SUBMITTING_ENTRY'],
      ['SUBMITTING_ENTRY', 'MONITORING'],
      ['MONITORING', 'EXITING'],
      ['EXITING', 'CLOSED'],
    ])
    // The MONITORING record carries the deadline instant for crash recovery.
    const monitoring = h.wal.readAll().find((r) => r.toState === 'MONITORING')
    expect(monitoring).toBeDefined()
    const monitoringPayload = monitoring?.payload as { tDeadlineMs?: number }
    expect(monitoringPayload.tDeadlineMs).toBe(DEADLINE_TS)
    expect(monitoring?.intentId).toBe(intentId)
  })
})

describe('engine — preflight reject', () => {
  it('aborts SELECTED → ABORTED{kill_switch} and places no order', () => {
    const h = build({ walPath, preflight: () => false })
    runSkeletonScenario(h)
    const intentId = triggeredIntentId(h)

    expect(h.engine.intentState(intentId)).toBe('ABORTED')
    const transitions = h.wal.readAll().map((r) => [r.fromState, r.toState])
    expect(transitions).toEqual([['SELECTED', 'ABORTED']])
    const aborted = h.wal.readAll()[0]
    expect(aborted).toBeDefined()
    const abortedPayload = aborted?.payload as { errorCode?: string }
    expect(abortedPayload.errorCode).toBe('kill_switch')
  })
})

describe('engine — multi-candidate scan', () => {
  it('schedules entry timers most-negative first', () => {
    const h = build({ walPath })
    const received: EngineEvent[] = []
    h.bus.subscribe((e) => received.push(e))

    const { clock, exchange, scheduler } = h
    exchange.setPrice(BTC.symbol, BTC.price)
    exchange.setPrice(ETH.symbol, ETH.price)
    // Both inside the proximity band around the -0.3 threshold; ETH is more negative → first.
    exchange.setPredictedFunding(BTC.symbol, -0.35, SCAN_TS) // less negative
    exchange.setPredictedFunding(ETH.symbol, -0.38, SCAN_TS) // more negative → first
    scheduler.start()
    clock.advanceTo(SCAN_TS)
    clock.advanceTo(ENTRY_TS)

    const entrySymbols = received
      .filter((e): e is Timer => e.type === 'Timer' && e.kind === 'entry')
      .map((t) => t.symbol)
    expect(entrySymbols).toEqual([ETH.symbol, BTC.symbol])
  })
})
