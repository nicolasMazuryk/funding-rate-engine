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
 * (0280), sizing is a fixed qty (real sizing 0280), and recovery covers only the
 * two skeleton states (full matrix 0370). Preflight (kill switch + risk gate +
 * balance/precision/account/market checks) lands here in 0140.
 */

import type { KillSwitchState } from '../../config/env.js'
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
import type { Balance, ExchangeAdapter, Order, Side } from '../ports/exchange-adapter.js'
import type { Repo } from '../ports/repo.js'
import type { RiskGate } from '../ports/risk-gate.js'
import type { TransitionLog, TransitionLogEntry } from '../ports/transition-log.js'
import type { RuntimeStrategyConfig, StrategyModule, StrategyRegistry } from '../strategies/registry.js'
import { evaluateProfitCondition, type ProfitBreakdown } from './cost-model.js'
import { type FindCandidatesInput, findCandidates } from './finder.js'
import { computeFundingSchedule } from './funding-schedule.js'
import { type PreflightSnapshot, runPreflight } from './preflight.js'
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
  /** Strategy dispatch table (Registry pattern, `08` §5) — the engine resolves the active module by `strategyConfig.id`. */
  readonly registry: StrategyRegistry
  /** Engine-level runtime config for the active strategy (threshold, direction, offset, hold, qty). */
  readonly strategyConfig: RuntimeStrategyConfig
  /** Risk gate evaluated in preflight (`13` §1). Defaults to always-allow. */
  readonly riskGate?: RiskGate
  /** Kill-switch state source read in preflight (`13` §2). Defaults to `off`. */
  readonly killSwitch?: { state(): KillSwitchState }
  /** Seed balance for the preflight margin check; `undefined` fails closed (no hidden default per fail-loud). */
  readonly initialBalance?: Balance
  /** Whether leverage/margin-mode setup ran in advance (`11` §1); real producer 0240. Defaults to `true`. */
  readonly accountSetupComplete?: boolean
  /** Reconciliation sink invoked after `CLOSED` (composition logs the diff; no throw on mismatch). */
  readonly onReconciliation?: (record: ReconciliationRecord) => void
}

/**
 * The five optional WAL fields carried on an intent's transitions — the exact
 * set crash recovery reads back to rebuild the deterministic order id, entry
 * side/qty/fill, and deadline instant from the WAL alone.
 */
export interface IntentWalFields {
  readonly clientOrderId?: string
  readonly entrySide?: Side
  readonly entryQty?: number
  readonly entryFillPx?: number
  readonly tDeadlineMs?: number
}

/**
 * The enriched WAL payload written on every transition — a superset of
 * {@link IntentTerminalPayload}. Crash recovery reads it back to rebuild the
 * symbol, deterministic order id, and deadline instant from the WAL alone.
 */
export type EnginePayload = IntentWalFields & {
  readonly symbol: string
  readonly exitReason?: ExitReason
  readonly errorCode?: ErrorCode
}

/** A non-terminal intent rebuilt from the WAL for {@link Engine.recover}. */
export type RecoveredIntent = IntentWalFields & {
  readonly intentId: string
  readonly symbol: string
  readonly state: IntentState
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
  /** Advisory cost-model breakdown captured at selection (task 0150), or `undefined` if none. */
  costBreakdown(intentId: string): ProfitBreakdown | undefined
  /** Unsubscribe from the bus (simulated crash: engine stops reacting). */
  dispose(): void
}

/** Extra WAL-payload fields set per transition, beyond the terminal `exitReason`/`errorCode`. */
type TransitionExtras = IntentWalFields

/** In-memory projection of one intent; the durable record is the WAL. */
interface IntentRecord {
  readonly symbol: string
  state: IntentState
  readonly entrySide: Side
  readonly entryQty: number
  entryFillPx?: number
  entryFillQty?: number
  deadlineMs?: number
  /** Advisory cost-model breakdown captured at selection (task 0150); in-memory analytics only, never WAL'd. */
  costBreakdown?: ProfitBreakdown
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

/** Resolve the active strategy module or fail loud — a misconfigured id is a startup bug. */
function resolveModule(registry: StrategyRegistry, id: RuntimeStrategyConfig['id']): StrategyModule {
  const module = registry.get(id)
  if (module === undefined) throw new Error(`Engine: no strategy module registered for id '${id}'`)
  return module
}

export function createEngine(deps: EngineDeps): Engine {
  const { bus, clock, scheduler, exchange, wal, repo, registry, strategyConfig } = deps
  const riskGate: RiskGate = deps.riskGate ?? { check: () => ({ allowed: true }) }
  const killSwitch = deps.killSwitch ?? { state: (): KillSwitchState => 'off' }
  const accountSetupComplete = deps.accountSetupComplete ?? true
  // Fail loud on misconfiguration: an id with no registered module is a startup bug, not a runtime skip.
  const activeModule = resolveModule(registry, strategyConfig.id)

  const intents = new Map<string, IntentRecord>()
  const pendingOrders = new Map<string, PendingOrder>()
  const predicted = new Map<string, FundingPredicted>()
  // Advisory cost-model breakdown per symbol, stashed at selection, copied onto the intent at entry (task 0150).
  const costBySymbol = new Map<string, ProfitBreakdown>()
  // Latest venue state the preflight reads, updated from the event stream.
  let latestBalance: Balance | undefined = deps.initialBalance
  const latestPrice = new Map<string, number>()

  /** Count of live (non-terminal) intents — the risk gate's concurrency input. */
  function countLiveIntents(): number {
    let count = 0
    for (const rec of intents.values()) if (!TERMINAL_INTENT_STATES.includes(rec.state)) count++
    return count
  }

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

    // JSON.stringify (WAL) and stableStringify (trace) both drop `undefined`, so
    // spreading the optional fields is byte-identical to conditionally setting them.
    const enriched: EnginePayload = { symbol, ...extras, ...payload }
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
    const nowMs = event.ts
    const universe = exchange
      .markets()
      .filter((m) => m.status === 'trading')
      .map((m) => m.normalized)
    const schedule = computeFundingSchedule(
      universe.map((symbol) => exchange.normalize(symbol)),
      nowMs,
    )
    const input: FindCandidatesInput = {
      universe,
      predicted,
      schedule,
      threshold: { percent: strategyConfig.thresholdPercent, direction: strategyConfig.direction },
      nowMs,
    }
    for (const candidate of findCandidates(input)) {
      const trigger = activeModule.select(candidate, strategyConfig)
      if (trigger === undefined) continue
      // Advisory economic gate (task 0150): evaluate NET_PNL condition with the live
      // funding rate, stash for the intent. Absent fee config ⇒ no evaluation.
      if (strategyConfig.costFees !== undefined) {
        costBySymbol.set(
          trigger.symbol,
          evaluateProfitCondition(strategyConfig.id, {
            fundingRatePercent: candidate.ratePercent,
            fees: strategyConfig.costFees,
            params: strategyConfig.costParams ?? {},
          }),
        )
      }
      // Entry timer fires `entryOffsetSeconds` before settlement (`00_globals.md` §7).
      scheduler.scheduleEntryTimer(trigger.symbol, trigger.settleTs - strategyConfig.entryOffsetSeconds * 1000)
    }
  }

  /** Build the preflight snapshot for `symbol` from the engine's current venue view. */
  function preflightSnapshot(symbol: string): PreflightSnapshot {
    const market = exchange.markets().find((m) => m.normalized === symbol)
    return {
      killSwitch: killSwitch.state(),
      openIntentCount: countLiveIntents(),
      breakerOpen: false, // hardcoded until circuit breakers land (0380).
      amountUsd: strategyConfig.amountUsd,
      leverage: strategyConfig.leverage,
      balance: latestBalance,
      qty: strategyConfig.entryQty,
      price: latestPrice.get(symbol),
      instrument: exchange.normalize(symbol),
      accountSetupComplete,
      marketStatus: market?.status ?? 'delisted',
    }
  }

  function onEntry(event: Timer): void {
    const symbol = event.symbol
    if (symbol === undefined) return
    const intentId = `${symbol}-${event.ts}`

    // Preflight before creating the intent row: `skip` leaves no trace (`12` §3 / `13` §6).
    const result = runPreflight(preflightSnapshot(symbol), riskGate, symbol)
    if (result.kind === 'skip') return

    const rec: IntentRecord = { symbol, state: 'SELECTED', entrySide: ENTRY_SIDE, entryQty: strategyConfig.entryQty }
    const stashedCost = costBySymbol.get(symbol)
    if (stashedCost !== undefined) rec.costBreakdown = stashedCost
    intents.set(intentId, rec)

    if (result.kind === 'reject') {
      commit({ intentId, symbol, from: 'SELECTED', to: 'ABORTED', payload: { errorCode: result.errorCode } })
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
    const deadlineMs = clock.now() + strategyConfig.holdMs
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
      // Latest price/balance feed the preflight snapshot (`12` §3).
      case 'MarketTick':
        latestPrice.set(event.symbol, event.price)
        return
      case 'BalanceUpdate':
        latestBalance = { asset: event.asset, free: event.free, used: event.used }
        return
      // Not consumed by the skeleton yet — explicit no-ops keep the switch exhaustive.
      case 'FundingSettled':
      case 'FundingFeeAccrued':
      case 'PositionUpdate':
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
      entryQty: r.entryQty ?? strategyConfig.entryQty,
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
      entryQty: r.entryQty ?? strategyConfig.entryQty,
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
    costBreakdown(intentId: string): ProfitBreakdown | undefined {
      return intents.get(intentId)?.costBreakdown
    },
    dispose(): void {
      unsubscribe()
    },
  }
}
