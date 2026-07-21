/**
 * Unified trace file (task 0170; `docs/trace-format.md`).
 *
 * One JSONL artifact that is *both* the operational log and the golden fixture —
 * one record per line, `stableStringify`-serialized so it is byte-stable
 * regardless of object construction order. It replaces task 0090's two separate
 * streams (WAL trace + events trace); a single monotonic `seq` across every
 * non-header record captures the true interleaving of bus events, WAL
 * transitions, and (future) order actions in observed order — the load-bearing
 * reason for one file, not two.
 *
 * The writer mirrors the WAL's synchronous-durable append (`openSync` + append),
 * so the whole trace is on disk by the time the driving clock advance returns —
 * no async drain before a byte-compare. See `docs/trace-format.md` for the record
 * kinds, versioning policy, and the input/output contract (event = replay input,
 * transition = recorded output/diffed, order-action = diagnostic only).
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync } from 'node:fs'
import type { EngineEvent } from '../core/events/types.js'
import type { TransitionLogEntry } from '../core/ports/transition-log.js'
import { stableStringify } from './stable-stringify.js'

/** Current trace-format version; replay refuses any record with a different `v` (`docs/trace-format.md`). */
export const TRACE_VERSION = 1

/** Config snapshot, always the first record and the only one without a `seq`. */
export interface TraceHeader {
  readonly v: 1
  readonly kind: 'header'
  readonly ts: number
  readonly configHash: string
  /** The interim `RuntimeStrategyConfig` (not a full `EffectiveConfig` — see the doc's config-header gap). */
  readonly strategyConfig: unknown
}

/** A bus event exactly as published — the replay INPUT stream. */
export interface TraceEvent {
  readonly v: 1
  readonly kind: 'event'
  readonly seq: number
  readonly ts: number
  readonly event: EngineEvent
}

/** A WAL transition — the recorded OUTPUT that replay diffs. */
export interface TraceTransition {
  readonly v: 1
  readonly kind: 'transition'
  readonly seq: number
  readonly ts: number
  readonly intentId: string
  readonly fromState: string
  readonly toState: string
  readonly payload: unknown
  readonly clientOrderId?: string
}

/** A venue order submit/cancel — diagnostic only, never diffed (`docs/trace-format.md`). */
export interface TraceOrderAction {
  readonly v: 1
  readonly kind: 'order-action'
  readonly seq: number
  readonly ts: number
  readonly action: 'place' | 'cancel'
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: string
  readonly qty: number
  readonly reduceOnly?: boolean
}

/**
 * A funding-gate open/close — diagnostic only, never diffed (task 0290; `docs/trace-format.md`).
 * How `intent.funding_gate_opened`/`_closed` reach the trace. Additive: `TRACE_VERSION` stays
 * `1` (`readTrace` rejects an unknown `v`, not an unknown `kind`; replay diffs only
 * `transition` records, so a `gate` record is ignored on replay).
 */
export interface TraceGate {
  readonly v: 1
  readonly kind: 'gate'
  readonly seq: number
  readonly ts: number
  readonly intentId: string
  readonly event: 'funding_gate_opened' | 'funding_gate_closed'
  /** Open source (`ws`|`rest`) — present on `funding_gate_opened`. */
  readonly source?: string
  /** `t_drop_offset_s` — present on `funding_gate_opened`. */
  readonly offsetS?: number
  /** Close reason (`opened`|`timeout`) — present on `funding_gate_closed`. */
  readonly reason?: string
}

export type TraceRecord = TraceHeader | TraceEvent | TraceTransition | TraceOrderAction | TraceGate

export interface TraceFile {
  /** Write the config header (call once, before any other record). */
  recordHeader(header: { readonly ts: number; readonly configHash: string; readonly strategyConfig: unknown }): void
  /** Append a bus event as an `event` record, stamped with the current time. */
  recordEvent(event: EngineEvent, ts: number): void
  /** Append a WAL transition as a `transition` record (mirrors `wal.append`). */
  recordTransition(entry: TransitionLogEntry): void
  /** Append a venue order action as an `order-action` record (diagnostic only). */
  recordOrderAction(action: Omit<TraceOrderAction, 'v' | 'kind' | 'seq'>): void
  /** Append a funding-gate open/close as a `gate` record (diagnostic only). */
  recordGate(gate: Omit<TraceGate, 'v' | 'kind' | 'seq'>): void
  /** Release the open file descriptor. */
  close(): void
}

/** Open (or create) a trace file at `path`; one shared `seq` counter across every non-header record. */
export function createTraceFile({ path }: { readonly path: string }): TraceFile {
  const fd = openSync(path, 'a')
  let seq = 0

  function write(record: TraceRecord): void {
    appendFileSync(fd, `${stableStringify(record)}\n`)
  }

  return {
    recordHeader(header): void {
      write({ v: TRACE_VERSION, kind: 'header', ...header })
    },
    recordEvent(event, ts): void {
      write({ v: TRACE_VERSION, kind: 'event', seq: seq++, ts, event })
    },
    recordTransition(entry): void {
      write({
        v: TRACE_VERSION,
        kind: 'transition',
        seq: seq++,
        ts: entry.ts,
        intentId: entry.intentId,
        fromState: entry.fromState,
        toState: entry.toState,
        payload: entry.payload,
        clientOrderId: entry.clientOrderId,
      })
    },
    recordOrderAction(action): void {
      write({ v: TRACE_VERSION, kind: 'order-action', seq: seq++, ...action })
    },
    recordGate(gate): void {
      write({ v: TRACE_VERSION, kind: 'gate', seq: seq++, ...gate })
    },
    close(): void {
      closeSync(fd)
    },
  }
}

/** Parse every JSONL record in `path`, in append order; a record with an unrecognized `v` is a hard error. */
export function readTrace(path: string): TraceRecord[] {
  if (!existsSync(path)) throw new Error(`[trace] no such trace file: ${path}`)
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
  return lines.map((line, i) => {
    const record = JSON.parse(line) as TraceRecord
    if (record.v !== TRACE_VERSION) {
      throw new Error(`[trace] unsupported version ${String(record.v)} at line ${i + 1} of ${path}`)
    }
    return record
  })
}
