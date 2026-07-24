/**
 * Scenario: **reconciliation (engine ↔ exchange)** (`15_accounting_and_reconciliation.md`
 * §2, task 0400). Drives the {@link createReconciler} sidecar directly against the sim venue
 * + a spy repo (no Postgres, no full engine) and asserts the four DoD dimensions:
 *   - fee divergence inside tolerance → `pnl` reflects the venue fee, one `venue_wins` diff row,
 *     and a second reconcile adds zero rows (idempotency);
 *   - fee divergence beyond tolerance → `reconcile.diff_beyond_tolerance` ops alert;
 *   - missed funding → `funding_events` backfilled + `funding_pnl` corrected + diff row;
 *   - position mismatch → `OrphanDetected` published (desync → 0380) + `desync` row, no pnl change.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createReconciler, type Reconciler } from '../../src/accounting/reconcile.js'
import { createVirtualClock, type VirtualClock } from '../../src/adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../../src/adapters/sim/sim-exchange.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { OrphanDetected } from '../../src/core/events/types.js'
import { makeClientOrderId } from '../../src/core/order-id/client-order-id.js'
import type {
  FundingEventRange,
  FundingEventRecord,
  IntentSnapshot,
  PnlRecordRow,
  PositionRecord,
  ReconciliationDiffRecord,
  Repo,
} from '../../src/core/ports/repo.js'
import type { OpsEvent, TradeCloseContext } from '../../src/core/runtime/engine.js'

/** Spy repo: the reconciler's persisted surface, plus assertion accessors. */
interface SpyRepo extends Repo {
  readonly diffs: ReconciliationDiffRecord[]
  readonly corrections: PnlRecordRow[]
  readonly fundingBackfills: FundingEventRecord[]
  pnl: PnlRecordRow | undefined
}

function createSpyRepo(seed?: { fundingEvents?: FundingEventRecord[]; positions?: PositionRecord[] }): SpyRepo {
  const diffs: ReconciliationDiffRecord[] = []
  const corrections: PnlRecordRow[] = []
  const fundingBackfills: FundingEventRecord[] = []
  const fundingEvents = [...(seed?.fundingEvents ?? [])]
  const positions = [...(seed?.positions ?? [])]
  let pnl: PnlRecordRow | undefined
  return {
    diffs,
    corrections,
    fundingBackfills,
    get pnl() {
      return pnl
    },
    set pnl(row) {
      pnl = row
    },
    upsertIntentState: (_s: IntentSnapshot) => Promise.resolve(),
    loadNonTerminalIntents: () => Promise.resolve([]),
    upsertPnl: (r) => {
      pnl = r
      return Promise.resolve()
    },
    upsertPnlCorrection: (r) => {
      pnl = r
      corrections.push(r)
      return Promise.resolve()
    },
    loadPnl: (_intentId: string) => Promise.resolve(pnl),
    loadFundingEventsForSymbol: (symbol: string, range: FundingEventRange) =>
      Promise.resolve(
        fundingEvents.filter(
          (e) => e.symbol === symbol && e.fundingTime >= range.fromMs && e.fundingTime <= range.toMs,
        ),
      ),
    upsertFundingEvent: (e) => {
      fundingEvents.push(e)
      fundingBackfills.push(e)
      return Promise.resolve()
    },
    upsertReconciliation: (r) => {
      diffs.push(r)
      return Promise.resolve()
    },
    loadPositions: () => Promise.resolve(positions),
  }
}

/** Drain the reconciler's fire-and-forget async chain (all sim/repo ops resolve on the microtask queue). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const INTENT = 'BTC-1000'
const SYMBOL = 'BTC'
const PRICE = 60_000
const QTY = 0.001
const T_SETTLE = 1_000

/** A closed-intent context: single S1 long entry at 60k, exit flat (zero price move). */
function closeCtx(over: Partial<TradeCloseContext> = {}): TradeCloseContext {
  return {
    intentId: INTENT,
    symbol: SYMBOL,
    strategyId: 's1',
    entrySide: 'long',
    exitReason: 'timed',
    pEntry: PRICE,
    pExit: PRICE,
    entryQty: QTY,
    filledQty: QTY,
    fillCount: 1,
    fundingReceived: false,
    closedAtMs: T_SETTLE + 300_000,
    tSettleMs: T_SETTLE,
    ...over,
  }
}

const ENTRY_COID = makeClientOrderId({ intentId: INTENT, leg: 'entry', attempt: 1 })

let clock: VirtualClock
let bus: ReturnType<typeof createEventBus>
let sim: SimExchange
let orphans: OrphanDetected[]
let ops: OpsEvent[]

beforeEach(() => {
  clock = createVirtualClock(0)
  bus = createEventBus()
  sim = createSimExchange(clock, bus)
  sim.setPrice(SYMBOL, PRICE)
  orphans = []
  ops = []
  bus.subscribe((e) => {
    if (e.type === 'OrphanDetected') orphans.push(e)
  })
})

function buildReconciler(
  repo: SpyRepo,
  tol: Partial<Parameters<typeof createReconciler>[0]['tolerances']> = {},
  fees = { takerFeePct: 0.04, makerFeePct: 0.02 },
): Reconciler {
  return createReconciler({
    repo,
    exchange: sim,
    bus,
    clock,
    tolerances: { fillPricePercent: 0.05, feeUsd: 0.05, fundingUsd: 0.01, qty: 1e-6, ...tol },
    sweepSeconds: 300,
    fees,
    onOpsEvent: (e) => ops.push(e),
  })
}

/** Place the entry order under its deterministic coid so `getOrder` returns the venue fill + fee, then flatten. */
async function placeEntryThenFlatten(fee?: number): Promise<void> {
  await sim.placeOrder({ symbol: SYMBOL, side: 'long', type: 'market', qty: QTY, clientOrderId: ENTRY_COID })
  if (fee !== undefined) sim.scriptOrderFee(ENTRY_COID, fee)
  sim.setPosition(SYMBOL, 'long', 0) // isolate the fills/funding dimensions from a position diff
}

describe('scenario: reconciliation — fee divergence (venue is truth for money)', () => {
  it('inside tolerance: corrects pnl to the venue fee, writes one venue_wins row, and is idempotent', async () => {
    const repo = createSpyRepo()
    await placeEntryThenFlatten() // sim default taker fee 0.04% × 60 = 0.024
    const reconciler = buildReconciler(repo)

    reconciler.onTradeClose(closeCtx())
    await flush()

    // Engine booked s1 group-L fee = 2 × 0.04% × 60 = 0.048; venue = 0.024 → within the 0.05 tolerance.
    const feeRows = repo.diffs.filter((d) => d.dimension === 'fills')
    expect(feeRows).toHaveLength(1)
    expect(feeRows[0]).toMatchObject({ resolution: 'venue_wins', withinTolerance: true, venueValue: 0.024 })
    // pnl corrected to the venue fee.
    expect(repo.corrections).toHaveLength(1)
    expect(repo.pnl?.feeCost).toBeCloseTo(0.024, 9)
    expect(repo.pnl?.netPnl).toBeCloseTo(-0.024, 9)
    // No beyond-tolerance alert.
    expect(ops).toHaveLength(0)

    // Idempotency: a second reconcile finds engine == venue ⇒ zero new rows, no pnl change.
    const diffCount = repo.diffs.length
    const correctionCount = repo.corrections.length
    reconciler.onTradeClose(closeCtx())
    await flush()
    expect(repo.diffs).toHaveLength(diffCount)
    expect(repo.corrections).toHaveLength(correctionCount)
  })

  it('beyond tolerance: emits the reconcile.diff_beyond_tolerance ops alert', async () => {
    const repo = createSpyRepo()
    await placeEntryThenFlatten(5.0) // wildly divergent venue fee
    const reconciler = buildReconciler(repo)

    reconciler.onTradeClose(closeCtx())
    await flush()

    expect(ops.map((o) => o.kind)).toContain('reconcile.diff_beyond_tolerance')
    const row = repo.diffs.find((d) => d.dimension === 'fills' && d.venueValue === 5.0)
    expect(row).toMatchObject({ withinTolerance: false, resolution: 'venue_wins' })
  })
})

describe('scenario: reconciliation — missed funding (engine has none, venue credited one)', () => {
  it('backfills funding_events, corrects funding_pnl, and writes the diff row', async () => {
    // Fees chosen so the config baseline fee equals the sim venue fee → no fee diff contaminates this test.
    const repo = createSpyRepo()
    await sim.placeOrder({ symbol: SYMBOL, side: 'long', type: 'market', qty: QTY, clientOrderId: ENTRY_COID })
    sim.settleFunding(SYMBOL, -0.4, T_SETTLE) // credits the account (fundingIncome) against the open long
    sim.setPosition(SYMBOL, 'long', 0) // flatten so the position dimension stays clean
    clock.advanceTo(T_SETTLE)
    const reconciler = buildReconciler(repo, {}, { takerFeePct: 0.02, makerFeePct: 0.02 })

    reconciler.onTradeClose(closeCtx())
    await flush()

    // Venue credited +|F|: 0.4% × 60 = 0.24 (long receives on negative funding).
    expect(repo.fundingBackfills).toHaveLength(1)
    expect(repo.fundingBackfills[0]).toMatchObject({ symbol: SYMBOL, fundingTime: T_SETTLE })
    expect(repo.fundingBackfills[0]?.amount).toBeCloseTo(0.24, 9)
    // pnl funding re-derived from the venue amount.
    expect(repo.pnl?.fundingPnl).toBeCloseTo(0.24, 9)
    expect(repo.pnl?.fundingReceived).toBe(true)
    // One funding diff row, venue_wins.
    const fundingRows = repo.diffs.filter((d) => d.dimension === 'funding')
    expect(fundingRows).toHaveLength(1)
    expect(fundingRows[0]).toMatchObject({ resolution: 'venue_wins', engineValue: 0 })
    expect(fundingRows[0]?.venueValue).toBeCloseTo(0.24, 9)
  })
})

describe('scenario: reconciliation — position mismatch (desync → orphan auto-flatten)', () => {
  it('publishes OrphanDetected, writes a desync row, and does not correct pnl', async () => {
    const repo = createSpyRepo()
    sim.setPosition(SYMBOL, 'long', 0.5) // a venue position with no owning intent
    const reconciler = buildReconciler(repo)

    // No entry order placed (getOrder throws → fills skipped); tSettle omitted → funding skipped.
    reconciler.onTradeClose(closeCtx({ tSettleMs: undefined }))
    await flush()

    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({ type: 'OrphanDetected', symbol: SYMBOL, side: 'long', qty: 0.5 })
    const positionRows = repo.diffs.filter((d) => d.dimension === 'position')
    expect(positionRows).toHaveLength(1)
    expect(positionRows[0]).toMatchObject({ resolution: 'desync', withinTolerance: false, venueValue: 0.5 })
    // Position desync never corrects money.
    expect(repo.corrections).toHaveLength(0)
  })
})

describe('scenario: reconciliation — periodic sweep', () => {
  it('re-arms on the sweep cadence and flags a venue position the engine does not hold', async () => {
    const repo = createSpyRepo({ positions: [] })
    sim.setPosition(SYMBOL, 'long', 0.3)
    const reconciler = buildReconciler(repo)
    reconciler.start()

    clock.advanceTo(300_000) // one sweep cadence
    await flush()

    expect(orphans.some((o) => o.symbol === SYMBOL && o.qty === 0.3)).toBe(true)
    expect(repo.diffs.some((d) => d.dimension === 'position' && d.resolution === 'desync')).toBe(true)
    reconciler.stop()
  })
})
