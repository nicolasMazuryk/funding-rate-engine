import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineEvent, Timer } from '../../../../src/core/events/types.js'
import type { ReconciliationRecord } from '../../../../src/core/runtime/engine.js'
import { createRiskGate } from '../../../../src/risk/gate.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../../../helpers/build-skeleton-engine.js'
import { harnessPool } from '../../../helpers/harness-pool.js'
import { createInMemoryRepo, type InMemoryRepo } from '../../../helpers/in-memory-repo.js'
import { pausedKillSwitch } from '../../../helpers/kill-switch.js'
import {
  BTC,
  DEADLINE_TS,
  ENTRY_TS,
  ETH,
  INTENT_ID,
  runSkeletonScenario,
  SCAN_TS,
  START_MS,
} from '../../../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../../../helpers/temp-dir.js'

let tmp: TempDir
let walPath: string
const pool = harnessPool()

function build(opts: Omit<Parameters<typeof buildSkeletonEngine>[0], 'startMs'>): SkeletonHarness {
  return pool.track(buildSkeletonEngine({ startMs: START_MS, ...opts }))
}

beforeEach(() => {
  tmp = tempDir('engine-test-')
  walPath = tmp.walPath
})

afterEach(() => {
  pool.disposeAll()
  tmp.dispose()
})

describe('engine — happy path', () => {
  it('drives SELECTED → … → CLOSED{timed} for the triggering symbol', async () => {
    const repo = createInMemoryRepo()
    const reconciliations: ReconciliationRecord[] = []
    const h = build({ walPath, repo, onReconciliation: (r) => reconciliations.push(r) })

    runSkeletonScenario(h)
    const intentId = INTENT_ID

    expect(h.engine.intentState(intentId)).toBe('CLOSED')
    // Position closed out (reduce-only exit flattened it).
    expect(await h.exchange.getPositions()).toEqual([])

    const snapshot = (repo as InMemoryRepo).snapshots().find((s) => s.intentId === intentId)
    expect(snapshot?.state).toBe('CLOSED')
    expect(snapshot?.exitReason).toBe('timed')

    // Reconciliation stub ran and matched engine fill vs venue. Real sizing:
    // amountUsd 60 / BTC price 60 000 / lot 0.001 → qty 0.001.
    expect(reconciliations).toEqual([
      {
        intentId,
        symbol: BTC.symbol,
        engineQty: 0.001,
        venueQty: 0.001,
        match: true,
      },
    ])
    // Position accrued funding: the entry filled before T_settle (`00_globals.md` §3.1).
    expect(h.engine.fundingReceived(intentId)).toBe(true)
  })

  it('writes exactly the four transition records to the WAL, in order', () => {
    const h = build({ walPath })
    runSkeletonScenario(h)
    const intentId = INTENT_ID

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
    const h = build({ walPath, killSwitch: pausedKillSwitch() })
    const placeOrder = vi.spyOn(h.exchange, 'placeOrder')
    runSkeletonScenario(h)
    const intentId = INTENT_ID

    expect(h.engine.intentState(intentId)).toBe('ABORTED')
    expect(placeOrder).not.toHaveBeenCalled()
    const transitions = h.wal.readAll().map((r) => [r.fromState, r.toState])
    expect(transitions).toEqual([['SELECTED', 'ABORTED']])
    const aborted = h.wal.readAll()[0]
    expect(aborted).toBeDefined()
    const abortedPayload = aborted?.payload as { errorCode?: string }
    expect(abortedPayload.errorCode).toBe('kill_switch')
  })

  it('rejects the second concurrent entry with risk_max_concurrent_intents', () => {
    const h = build({ walPath, riskGate: createRiskGate({ maxConcurrentIntents: 1, maxNotionalUsd: 100 }) })
    const { clock, exchange, scheduler } = h
    exchange.setPrice(BTC.symbol, BTC.price)
    exchange.setPrice(ETH.symbol, ETH.price)
    // Both inside the proximity band; ETH is more negative → enters first (stays live at MONITORING).
    exchange.setPredictedFunding(BTC.symbol, -0.35, SCAN_TS)
    exchange.setPredictedFunding(ETH.symbol, -0.38, SCAN_TS)
    scheduler.start()
    clock.advanceTo(SCAN_TS)
    clock.advanceTo(ENTRY_TS)

    // ETH occupies the single slot; BTC's entry is rejected by the concurrency limit.
    expect(h.engine.intentState(`${ETH.symbol}-${ENTRY_TS}`)).toBe('MONITORING')
    const btcId = `${BTC.symbol}-${ENTRY_TS}`
    expect(h.engine.intentState(btcId)).toBe('ABORTED')
    const btcAbort = h.wal.readAll().find((r) => r.intentId === btcId && r.toState === 'ABORTED')
    expect(btcAbort).toBeDefined()
    const btcPayload = btcAbort?.payload as { errorCode?: string }
    expect(btcPayload.errorCode).toBe('risk_max_concurrent_intents')
  })

  it('aborts with insufficient_balance when free balance is below required margin', () => {
    // amountUsd 60 / leverage 1 needs 60; only 10 free.
    const h = build({ walPath, initialBalance: { asset: 'USDT', free: 10, used: 0 } })
    runSkeletonScenario(h)
    const intentId = INTENT_ID

    expect(h.engine.intentState(intentId)).toBe('ABORTED')
    const transitions = h.wal.readAll().map((r) => [r.fromState, r.toState])
    expect(transitions).toEqual([['SELECTED', 'ABORTED']])
    const aborted = h.wal.readAll()[0]
    expect(aborted).toBeDefined()
    const abortedPayload = aborted?.payload as { errorCode?: string }
    expect(abortedPayload.errorCode).toBe('insufficient_balance')
  })
})

describe('engine — preflight skip', () => {
  it('leaves no intent row when the sized order is infeasible', () => {
    const repo = createInMemoryRepo()
    const h = build({ walPath, repo })
    const { clock, exchange, scheduler } = h
    // amountUsd 60 / price 100 000 → rawQty 0.0006 < lot 0.001 → floors to 0 → zero_qty → skip.
    exchange.setPrice(BTC.symbol, 100_000)
    exchange.setPrice(ETH.symbol, ETH.price)
    exchange.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
    exchange.setPredictedFunding(ETH.symbol, ETH.predicted, SCAN_TS)
    scheduler.start()
    clock.advanceTo(SCAN_TS)
    clock.advanceTo(ENTRY_TS)

    const intentId = `${BTC.symbol}-${ENTRY_TS}`
    expect(h.engine.intentState(intentId)).toBeUndefined()
    expect(h.wal.readAll()).toHaveLength(0)
    expect((repo as InMemoryRepo).snapshots().find((s) => s.intentId === intentId)).toBeUndefined()
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
