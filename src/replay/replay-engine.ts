/**
 * Replay engine (task 0170; spec `0000` §6, `14` §2) — the no-live-venue debugger.
 *
 * Drives a recorded trace's `event` stream back through a **fresh** pure core and
 * diffs the resulting WAL `transition`s against the recorded ones (positionally,
 * in append order — never re-sorted). Shared by the CLI (`scripts/replay.ts`) and
 * the golden test (`test/golden/skeleton.test.ts`): one code path, so a replay
 * divergence and a golden-fixture drift are the same failure.
 *
 * The fresh harness gets two **inert** ports so the recorded events are the *sole*
 * driver — no feedback duplicates:
 *   - an inert scheduler: engine `scheduleEntryTimer`/`scheduleDeadlineTimer` calls
 *     are no-ops, so recorded `Timer` events are the only timers (never re-derived).
 *   - an order-suppressing sim: `placeOrder`/`cancelOrder` neither emit nor throw,
 *     so recorded `OrderUpdate`/`PositionUpdate` events are the only fills. Market
 *     metadata (`markets`/`normalize`) still comes from the real sim so the finder
 *     and preflight see the true instrument universe.
 *
 * `order-action` records are diagnostic only and never diffed (scope: diff
 * transitions — `docs/trace-format.md`).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVirtualClock } from '../adapters/clock/virtual-clock.js'
import { createSimExchange, type SimExchange } from '../adapters/sim/sim-exchange.js'
import { createEventBus } from '../core/events/bus.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { OrderAck, OrderRequest } from '../core/ports/exchange-adapter.js'
import type { Scheduler } from '../core/runtime/scheduler.js'
import type { RuntimeStrategyConfig } from '../core/strategies/registry.js'
import { buildSkeletonEngine } from './build-skeleton-harness.js'
import { stableStringify } from './stable-stringify.js'
import { readTrace, type TraceHeader, type TraceRecord } from './trace-file.js'

/** The transition fields diffed by replay — WAL `seq` and trace-record framing excluded. */
export interface ReplayTransition {
  readonly ts: number
  readonly intentId: string
  readonly fromState: string
  readonly toState: string
  readonly payload: unknown
  readonly clientOrderId?: string
}

/** The first index where recorded and actual transitions differ (or a length mismatch). */
export interface FirstDivergence {
  readonly index: number
  /** Sequence number of the diverging record (recorded side when present, else actual). */
  readonly seq: number
  readonly intentId: string
  readonly expected?: ReplayTransition
  readonly actual?: ReplayTransition
}

export interface ReplayResult {
  readonly match: boolean
  readonly firstDivergence?: FirstDivergence
  readonly expected: readonly ReplayTransition[]
  readonly actual: readonly ReplayTransition[]
}

interface Seqd {
  readonly seq: number
  readonly t: ReplayTransition
}

/** An inert scheduler: the engine may schedule, but nothing fires — recorded `Timer`s drive time. */
function createInertScheduler(): Scheduler {
  const handle = { cancel(): void {} }
  return {
    start(): void {},
    stop(): void {},
    scheduleEntryTimer: () => handle,
    scheduleDeadlineTimer: () => handle,
  }
}

/**
 * A sim venue with order submission suppressed: `placeOrder`/`cancelOrder` return
 * a bare ack and emit nothing, so replayed `OrderUpdate`s are never duplicated by a
 * live fill. Every other member (market metadata, `getOrder`, funding) is the real
 * sim's, spread through unchanged.
 */
function createReplayExchange(clock: Clock, bus: EventBus): SimExchange {
  const sim = createSimExchange(clock, bus)
  return {
    ...sim,
    placeOrder(req: OrderRequest): Promise<OrderAck> {
      return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: req.clientOrderId })
    },
    cancelOrder(): Promise<void> {
      return Promise.resolve()
    },
  }
}

/** Read a trace's header (first record) or fail loud — every trace begins with one. */
function readHeader(records: readonly TraceRecord[], path: string): TraceHeader {
  const first = records[0]
  if (first?.kind !== 'header') throw new Error(`[replay] ${path}: first record is not a header`)
  return first
}

/** Map a WAL/trace transition to the diffed subset. */
function toTransition(r: {
  ts: number
  intentId: string
  fromState: string
  toState: string
  payload: unknown
  clientOrderId?: string
}): ReplayTransition {
  return {
    ts: r.ts,
    intentId: r.intentId,
    fromState: r.fromState,
    toState: r.toState,
    payload: r.payload,
    clientOrderId: r.clientOrderId,
  }
}

/** The recorded `transition` records of a trace, in append order. */
function recordedTransitions(records: readonly TraceRecord[]): Seqd[] {
  return records
    .filter((r): r is Extract<TraceRecord, { kind: 'transition' }> => r.kind === 'transition')
    .map((r) => ({ seq: r.seq, t: toTransition(r) }))
}

/**
 * Replay `records`' events through a fresh core and return the transitions it
 * produces (from the fresh WAL, in append order). The tmp WAL is deleted after.
 */
function runReplay(records: readonly TraceRecord[], header: TraceHeader): Seqd[] {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'))
  const walPath = join(dir, 'replay.wal.jsonl')
  const clock = createVirtualClock(header.ts)
  const bus = createEventBus()
  const h = buildSkeletonEngine({
    startMs: header.ts,
    walPath,
    clock,
    bus,
    exchange: createReplayExchange(clock, bus),
    scheduler: createInertScheduler(),
    strategyConfig: header.strategyConfig as RuntimeStrategyConfig,
    // Replay reproduces already-decided transitions from the recorded event stream; the risk gate's
    // limits are an edge-config concern not carried in the trace header (the harness default caps
    // notional at 100, which would spuriously ABORT a larger capture, e.g. S4.1a's 300-USD ladder).
    // Always-allow keeps replay faithful to the captured decisions. (Threading risk limits into the
    // header is a SUGGESTION.)
    riskGate: { check: () => ({ allowed: true }) },
  })
  try {
    for (const record of records) {
      if (record.kind !== 'event') continue
      clock.advanceTo(record.ts) // monotonic: a past-dated event is a no-op advance, never a rewind
      bus.publish(record.event)
    }
    h.engine.dispose()
    h.wal.close()
    return h.wal.readAll().map((w) => ({ seq: w.seq, t: toTransition(w) }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Positional diff of recorded vs actual transitions; first differing index (or length mismatch) wins. */
function diff(expected: readonly Seqd[], actual: readonly Seqd[]): FirstDivergence | undefined {
  const max = Math.max(expected.length, actual.length)
  for (let i = 0; i < max; i++) {
    const e = expected[i]
    const a = actual[i]
    if (e && a && stableStringify(e.t) === stableStringify(a.t)) continue
    const source = e ?? a
    return {
      index: i,
      seq: source?.seq ?? i,
      intentId: source?.t.intentId ?? '<none>',
      expected: e?.t,
      actual: a?.t,
    }
  }
  return undefined
}

/**
 * Replay `opts.file`'s events through a fresh core and diff the resulting
 * transitions against the recorded ones — from `opts.expectFile` when given
 * (compare-to-golden), else from `opts.file` itself (self-consistency).
 */
export function replayTrace(opts: { readonly file: string; readonly expectFile?: string }): ReplayResult {
  const inputRecords = readTrace(opts.file)
  const header = readHeader(inputRecords, opts.file)

  const expectedRecords = opts.expectFile === undefined ? inputRecords : readTrace(opts.expectFile)
  const expected = recordedTransitions(expectedRecords)
  const actual = runReplay(inputRecords, header)

  const firstDivergence = diff(expected, actual)
  return {
    match: firstDivergence === undefined,
    firstDivergence,
    expected: expected.map((s) => s.t),
    actual: actual.map((s) => s.t),
  }
}

/** One-line description of a transition for human diffs. */
function describe(t: ReplayTransition | undefined): string {
  if (t === undefined) return '<missing>'
  return `${t.intentId} ${t.fromState}->${t.toState} @${t.ts}`
}

/** Human-readable replay verdict with ±`context` transitions around the first divergence. */
export function formatReplayResult(result: ReplayResult, context = 3): string {
  if (result.match) {
    return `replay OK — ${result.actual.length} transitions match`
  }
  const d = result.firstDivergence
  if (d === undefined) return 'replay MISMATCH (no divergence detail)' // unreachable: !match ⇒ divergence
  const lines: string[] = [
    `replay MISMATCH at transition #${d.index} (seq ${d.seq}, intent ${d.intentId})`,
    `  expected: ${describe(d.expected)}`,
    `  actual:   ${describe(d.actual)}`,
  ]
  const from = Math.max(0, d.index - context)
  if (from < d.index) {
    lines.push(`  context (${from}..${d.index - 1}):`)
    for (let i = from; i < d.index; i++) {
      lines.push(`    #${i} ${describe(result.expected[i] ?? result.actual[i])}`)
    }
  }
  return lines.join('\n')
}
