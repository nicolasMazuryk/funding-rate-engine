/**
 * Skeleton engine — the walking-skeleton wiring (task 0090; `08` §8 end-to-end
 * flow, `12` §5 intent FSM). Pure core: it depends only on ports and other core
 * modules, receives concrete implementations as `EngineDeps`, and performs no I/O
 * of its own (the WAL/repo/exchange it calls are ports).
 *
 * The one event dispatcher drives the thin vertical slice:
 *   Timer(scan) → finder → Timer(entry) → preflight → SELECTED→SUBMITTING_ENTRY
 *   → order fill → SUBMITTING_ENTRY→MONITORING → Timer(deadline)
 *   → MONITORING→EXITING → reduce-only fill → EXITING→CLOSED{timed} → reconcile.
 *
 * WAL-before-side-effect (`14` §2.1): {@link commit} appends the transition to the
 * `TransitionLog` (fsync-durable before it returns) *before* the `placeOrder` /
 * `upsertIntentState` it gates are kicked off. The WAL payload is an
 * {@link EnginePayload} superset of the intent's terminal payload, carrying the
 * symbol, deterministic `clientOrderId`, entry side/qty/fill, and the exact
 * `tDeadlineMs` — everything crash recovery needs to rebuild from the WAL alone.
 *
 * This is skeleton wiring, not the production runtime: the strategy is a stub
 * (0280), preflight is a bare boolean (real risk gate 0140), and recovery covers
 * only the two skeleton states (full matrix 0370).
 */

import { assertNever, type EngineEvent, type FundingPredicted, type OrderUpdate, type Timer } from '../events/types.js'
import {
  type ErrorCode,
  type ExitReason,
  type IntentState,
  type IntentTerminalPayload,
  TERMINAL_INTENT_STATES,
  transitionIntent,
} from '../intent/intent-machine.js'
import type { EventBus, Unsubscribe } from '../ports/bus.js'
import type { Clock } from '../ports/clock.js'
import type { ExchangeAdapter, Order, Side } from '../ports/exchange-adapter.js'
import type { Repo } from '../ports/repo.js'
import type { TransitionLog, TransitionLogEntry } from '../ports/transition-log.js'
import type { StubStrategy } from '../strategies/stub.js'
import { findCandidates } from './finder.js'
import type { Scheduler } from './scheduler.js'

/** Skeleton is long-only (`sim-exchange.ts` accrual convention: longs profit on very-negative funding). */
const ENTRY_SIDE: Side = 'long'
/** Reduce-only close of a long is a short. */
const EXIT_SIDE: Side = 'short'

/** The concrete ports the engine is wired with (`main.ts` supplies the real ones; tests supply fakes). */
export interface EngineDeps {
  readonly bus: EventBus
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly exchange: ExchangeAdapter
  readonly wal: TransitionLog
  readonly repo: Repo
  readonly strategy: StubStrategy
  /** Preflight stub: a single kill-switch-style boolean, evaluated before entry (real gate 0140). Defaults to always-pass. */
  readonly preflight?: () => boolean
  /** Reconciliation sink invoked after `CLOSED` (composition logs the diff; no throw on mismatch). */
  readonly onReconciliation?: (record: ReconciliationRecord) => void
}

/**
 * The enriched WAL payload written on every transition — a superset of
 * {@link IntentTerminalPayload}. Crash recovery reads it back to rebuild the
 * symbol, deterministic order id, and deadline instant from the WAL alone.
 */
export interface EnginePayload {
  readonly symbol: string
  readonly clientOrderId?: string
  readonly entrySide?: Side
  readonly entryQty?: number
  readonly entryFillPx?: number
  readonly tDeadlineMs?: number
  readonly exitReason?: ExitReason
  readonly errorCode?: ErrorCode
}

/** A non-terminal intent rebuilt from the WAL for {@link Engine.recover}. */
export interface RecoveredIntent {
  readonly intentId: string
  readonly symbol: string
  readonly state: IntentState
  readonly clientOrderId?: string
  readonly entrySide?: Side
  readonly entryQty?: number
  readonly entryFillPx?: number
  readonly tDeadlineMs?: number
}

/** The reconciliation stub's finding: engine fill record vs venue ground truth (`15`, real reconciliation 0400). */
export interface ReconciliationRecord {
  readonly intentId: string
  readonly symbol: string
  readonly engineQty: number
  readonly venueQty: number
  readonly match: boolean
}

export interface Engine {
  /** Rebuild in-memory state from recovered intents and re-drive them (call before advancing the clock). */
  recover(recovered: readonly RecoveredIntent[]): Promise<void>
  /** Current FSM state of an intent, or `undefined` if unknown to this engine. */
  intentState(intentId: string): IntentState | undefined
  /** Unsubscribe from the bus (simulated crash: engine stops reacting). */
  dispose(): void
}

/** Extra WAL-payload fields set per transition, beyond the terminal `exitReason`/`errorCode`. */
interface TransitionExtras {
  readonly clientOrderId?: string
  readonly entrySide?: Side
  readonly entryQty?: number
  readonly entryFillPx?: number
  readonly tDeadlineMs?: number
}

/** In-memory projection of one intent; the durable record is the WAL. */
interface IntentRecord {
  readonly symbol: string
  state: IntentState
  readonly entrySide: Side
  readonly entryQty: number
  entryFillPx?: number
  entryFillQty?: number
  deadlineMs?: number
}

/** `pendingOrders` value: which intent/leg a `clientOrderId` belongs to. */
interface PendingOrder {
  readonly intentId: string
  readonly leg: 'entry' | 'exit'
}

/**
 * Rebuild the recoverable intents from a WAL replay: the last record per
 * `intentId`, dropped if terminal. Pure (no I/O) so it lives in core; the WAL
 * file's `readAll()` returns records that structurally satisfy the input type.
 */
export function recoveredFromWal(records: readonly TransitionLogEntry[]): readonly RecoveredIntent[] {
  const lastByIntent = new Map<string, TransitionLogEntry>()
  for (const record of records) lastByIntent.set(record.intentId, record)

  const recovered: RecoveredIntent[] = []
  for (const record of lastByIntent.values()) {
    const state = record.toState as IntentState
    if (TERMINAL_INTENT_STATES.includes(state)) continue
    const payload = (record.payload ?? {}) as EnginePayload
    recovered.push({
      intentId: record.intentId,
      symbol: payload.symbol,
      state,
      clientOrderId: record.clientOrderId,
      entrySide: payload.entrySide,
      entryQty: payload.entryQty,
      entryFillPx: payload.entryFillPx,
      tDeadlineMs: payload.tDeadlineMs,
    })
  }
  return recovered
}

/** `transitionIntent` typed for dynamic (non-literal) `from`/`to`; it still runtime-validates the transition + R12. */
const validateTransition = transitionIntent as unknown as (
  from: IntentState,
  to: IntentState,
  payload: IntentTerminalPayload,
) => IntentTerminalPayload

export function createEngine(deps: EngineDeps): Engine {
  const { bus, clock, scheduler, exchange, wal, repo, strategy } = deps
  const preflight = deps.preflight ?? (() => true)

  const intents = new Map<string, IntentRecord>()
  const pendingOrders = new Map<string, PendingOrder>()
  const predicted = new Map<string, FundingPredicted>()

  /**
   * Validate and record one transition, then durably WAL it before the side
   * effect it gates. Order matters: `wal.append` is fsync-durable by the time it
   * returns (even un-awaited), so it precedes any `placeOrder`/`upsertIntentState`.
   */
  function commit(params: {
    readonly intentId: string
    readonly symbol: string
    readonly from: IntentState
    readonly to: IntentState
    readonly payload: IntentTerminalPayload
    readonly extras?: TransitionExtras
  }): void {
    const { intentId, symbol, from, to, payload, extras = {} } = params
    validateTransition(from, to, payload) // legal-transition + R12 check (throws on violation)

    const enriched: EnginePayload = {
      symbol,
      ...(extras.clientOrderId !== undefined ? { clientOrderId: extras.clientOrderId } : {}),
      ...(extras.entrySide !== undefined ? { entrySide: extras.entrySide } : {}),
      ...(extras.entryQty !== undefined ? { entryQty: extras.entryQty } : {}),
      ...(extras.entryFillPx !== undefined ? { entryFillPx: extras.entryFillPx } : {}),
      ...(extras.tDeadlineMs !== undefined ? { tDeadlineMs: extras.tDeadlineMs } : {}),
      ...(payload.exitReason !== undefined ? { exitReason: payload.exitReason } : {}),
      ...(payload.errorCode !== undefined ? { errorCode: payload.errorCode } : {}),
    }
    // WAL first — this gates the side effect (`14` §2.1). appendFileSync fsyncs
    // before returning, so durability holds even though we do not await.
    void wal.append({
      ts: clock.now(),
      intentId,
      fromState: from,
      toState: to,
      payload: enriched,
      clientOrderId: extras.clientOrderId,
    })
    // Current-state projection (independent of the WAL append).
    void repo.upsertIntentState({
      intentId,
      state: to,
      symbol,
      exitReason: payload.exitReason,
      errorCode: payload.errorCode,
    })
    const rec = intents.get(intentId)
    if (rec) rec.state = to
  }

  function onFundingPredicted(event: FundingPredicted): void {
    predicted.set(event.symbol, event)
  }

  function onScan(event: Timer): void {
    for (const candidate of findCandidates(predicted.values(), strategy)) {
      scheduler.scheduleEntryTimer(candidate.symbol, event.ts + strategy.config.entryOffsetMs)
    }
  }

  function onEntry(event: Timer): void {
    const symbol = event.symbol
    if (symbol === undefined) return
    const intentId = `${symbol}-${event.ts}`
    const rec: IntentRecord = { symbol, state: 'SELECTED', entrySide: ENTRY_SIDE, entryQty: strategy.config.entryQty }
    intents.set(intentId, rec)

    if (!preflight()) {
      commit({ intentId, symbol, from: 'SELECTED', to: 'ABORTED', payload: { errorCode: 'kill_switch' } })
      return
    }

    const clientOrderId = `${intentId}-entry-1`
    commit({
      intentId,
      symbol,
      from: 'SELECTED',
      to: 'SUBMITTING_ENTRY',
      payload: {},
      extras: { clientOrderId, entrySide: rec.entrySide, entryQty: rec.entryQty },
    })
    pendingOrders.set(clientOrderId, { intentId, leg: 'entry' })
    void exchange.placeOrder({ symbol, side: rec.entrySide, type: 'market', qty: rec.entryQty, clientOrderId })
  }

  function onDeadline(event: Timer): void {
    const intentId = event.intentId
    if (intentId === undefined) return
    const rec = intents.get(intentId)
    if (rec?.state !== 'MONITORING') return

    const clientOrderId = `${intentId}-exit-1`
    commit({ intentId, symbol: rec.symbol, from: 'MONITORING', to: 'EXITING', payload: {}, extras: { clientOrderId } })
    pendingOrders.set(clientOrderId, { intentId, leg: 'exit' })
    void exchange.placeOrder({
      symbol: rec.symbol,
      side: EXIT_SIDE,
      type: 'market',
      qty: rec.entryQty,
      clientOrderId,
      reduceOnly: true,
    })
  }

  function onTimer(event: Timer): void {
    if (event.kind === 'scan') onScan(event)
    else if (event.kind === 'entry') onEntry(event)
    else onDeadline(event)
  }

  /** Adopt an entry fill (real update or recovered-and-confirmed): record it and advance to `MONITORING`. */
  function adoptEntryFill(
    intentId: string,
    rec: IntentRecord,
    fillPx: number | undefined,
    fillQty: number | undefined,
  ): void {
    const deadlineMs = clock.now() + strategy.config.holdMs
    rec.entryFillPx = fillPx
    rec.entryFillQty = fillQty
    rec.deadlineMs = deadlineMs
    commit({
      intentId,
      symbol: rec.symbol,
      from: 'SUBMITTING_ENTRY',
      to: 'MONITORING',
      payload: {},
      extras: { entrySide: rec.entrySide, entryQty: rec.entryQty, entryFillPx: fillPx, tDeadlineMs: deadlineMs },
    })
    scheduler.scheduleDeadlineTimer(intentId, deadlineMs)
  }

  function onEntryOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    if (event.status === 'FILLED') {
      pendingOrders.delete(event.clientOrderId)
      adoptEntryFill(intentId, rec, event.fillPx, event.qty)
      return
    }
    if (event.status === 'REJECTED' || event.status === 'FAILED') {
      pendingOrders.delete(event.clientOrderId)
      const errorCode: ErrorCode = event.status === 'REJECTED' ? 'main_order_rejected' : 'main_order_failed'
      commit({ intentId, symbol: rec.symbol, from: 'SUBMITTING_ENTRY', to: 'ENTRY_FAILED', payload: { errorCode } })
    }
  }

  function onExitOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    if (event.status !== 'FILLED') return
    pendingOrders.delete(event.clientOrderId)
    commit({ intentId, symbol: rec.symbol, from: 'EXITING', to: 'CLOSED', payload: { exitReason: 'timed' } })
    void finishReconciliation(intentId)
  }

  function onOrderUpdate(event: OrderUpdate): void {
    const pending = pendingOrders.get(event.clientOrderId)
    if (!pending) return
    const rec = intents.get(pending.intentId)
    if (!rec) return
    if (pending.leg === 'entry') onEntryOrderUpdate(event, pending.intentId, rec)
    else onExitOrderUpdate(event, pending.intentId, rec)
  }

  /** Reconciliation stub: compare the engine's recorded entry fill against venue ground truth; log, never throw (0400 replaces). */
  async function finishReconciliation(intentId: string): Promise<void> {
    const rec = intents.get(intentId)
    if (!rec) return
    const engineQty = rec.entryFillQty ?? rec.entryQty
    let venueQty = 0
    try {
      const order = await exchange.getOrder(`${intentId}-entry-1`)
      venueQty = order.qty ?? 0
    } catch {
      venueQty = 0
    }
    deps.onReconciliation?.({ intentId, symbol: rec.symbol, engineQty, venueQty, match: engineQty === venueQty })
  }

  function dispatch(event: EngineEvent): void {
    switch (event.type) {
      case 'FundingPredicted':
        onFundingPredicted(event)
        return
      case 'Timer':
        onTimer(event)
        return
      case 'OrderUpdate':
        onOrderUpdate(event)
        return
      // Not consumed by the skeleton yet — explicit no-ops keep the switch exhaustive.
      case 'FundingSettled':
      case 'FundingFeeAccrued':
      case 'MarketTick':
      case 'PositionUpdate':
      case 'BalanceUpdate':
        return
      default:
        assertNever(event)
    }
  }

  async function recoverSubmitting(r: RecoveredIntent): Promise<void> {
    const rec: IntentRecord = {
      symbol: r.symbol,
      state: 'SUBMITTING_ENTRY',
      entrySide: r.entrySide ?? ENTRY_SIDE,
      entryQty: r.entryQty ?? strategy.config.entryQty,
    }
    intents.set(r.intentId, rec)
    const clientOrderId = r.clientOrderId ?? `${r.intentId}-entry-1`

    let order: Order | undefined
    try {
      order = await exchange.getOrder(clientOrderId)
    } catch {
      order = undefined // WAL has the order but the venue never saw it (`14` §5 step 4) — re-submit.
    }
    if (order?.status === 'FILLED') {
      adoptEntryFill(r.intentId, rec, order.fillPx, order.qty) // already on venue — adopt, no re-submit.
      return
    }
    // Re-submit with the SAME clientOrderId — idempotent by construction, no duplicate.
    pendingOrders.set(clientOrderId, { intentId: r.intentId, leg: 'entry' })
    void exchange.placeOrder({
      symbol: r.symbol,
      side: rec.entrySide,
      type: 'market',
      qty: rec.entryQty,
      clientOrderId,
    })
  }

  async function recoverMonitoring(r: RecoveredIntent): Promise<void> {
    const rec: IntentRecord = {
      symbol: r.symbol,
      state: 'MONITORING',
      entrySide: r.entrySide ?? ENTRY_SIDE,
      entryQty: r.entryQty ?? strategy.config.entryQty,
      entryFillPx: r.entryFillPx,
      deadlineMs: r.tDeadlineMs,
    }
    intents.set(r.intentId, rec)
    // Reconcile qty against venue ground truth — do NOT replace the live order.
    const positions = await exchange.getPositions()
    rec.entryFillQty = positions.find((p) => p.symbol === r.symbol)?.qty ?? r.entryQty
    if (r.tDeadlineMs !== undefined) scheduler.scheduleDeadlineTimer(r.intentId, r.tDeadlineMs)
  }

  const unsubscribe: Unsubscribe = bus.subscribe(dispatch)

  return {
    async recover(recovered: readonly RecoveredIntent[]): Promise<void> {
      for (const r of recovered) {
        if (r.state === 'SUBMITTING_ENTRY') await recoverSubmitting(r)
        else if (r.state === 'MONITORING') await recoverMonitoring(r)
      }
    },
    intentState(intentId: string): IntentState | undefined {
      return intents.get(intentId)?.state
    },
    dispose(): void {
      unsubscribe()
    },
  }
}
