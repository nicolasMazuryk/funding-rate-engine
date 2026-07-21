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
 * This is skeleton wiring, not the production runtime: the strategy is a
 * placeholder (0280), sizing is a fixed qty (real sizing 0280), and recovery covers only the
 * two skeleton states (full matrix 0370). Preflight (kill switch + risk gate +
 * balance/precision/account/market checks) lands here in 0140.
 */

import type { KillSwitchState } from '../../config/env.js'
import { assertNever, type EngineEvent, type FundingPredicted, type OrderUpdate, type Timer } from '../events/types.js'
import type {
  ExitLegRequest,
  ExitPolicyContext,
  ExitPolicyHandler,
  ExitPolicyRegistry,
  MonitoredEvent,
  MonitoredIntent,
} from '../intent/exit-policy.js'
import {
  type ErrorCode,
  type ExitReason,
  type IntentState,
  type IntentTerminalPayload,
  TERMINAL_INTENT_STATES,
  transitionIntent,
} from '../intent/intent-machine.js'
import { makeClientOrderId } from '../order-id/client-order-id.js'
import type { EventBus, Unsubscribe } from '../ports/bus.js'
import type { Clock } from '../ports/clock.js'
import type { Balance, ExchangeAdapter, Order, Side } from '../ports/exchange-adapter.js'
import type { Repo } from '../ports/repo.js'
import type { RiskGate } from '../ports/risk-gate.js'
import type { TransitionLog, TransitionLogEntry } from '../ports/transition-log.js'
import { capReduceOnlyQty, computeQty, roundPrice } from '../sizing/sizing.js'
import type { RuntimeStrategyConfig, StrategyModule, StrategyRegistry } from '../strategies/registry.js'
import { evaluateProfitCondition, type ProfitBreakdown } from './cost-model.js'
import { type FindCandidatesInput, findCandidates } from './finder.js'
import { computeFundingSchedule } from './funding-schedule.js'
import { type PreflightSnapshot, runPreflight } from './preflight.js'
import type { Scheduler } from './scheduler.js'

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
  /** Exit-policy dispatch table (`12` §5) — the engine resolves the active module's `exitPolicyKind` handler. */
  readonly exitPolicyRegistry: ExitPolicyRegistry
  /** Engine-level runtime config for the active strategy (threshold, direction, entry/exit offsets, sizing). */
  readonly strategyConfig: RuntimeStrategyConfig
  /** Risk gate evaluated in preflight (`13` §1). Defaults to always-allow. */
  readonly riskGate?: RiskGate
  /** Kill-switch state source read in preflight (`13` §2). Defaults to `off`. */
  readonly killSwitch?: { state(): KillSwitchState }
  /** Seed balance for the preflight margin check; `undefined` fails closed (no hidden default per fail-loud). */
  readonly initialBalance?: Balance
  /**
   * Whether leverage/margin-mode setup ran in advance (`11` §1). A flat `boolean` or a
   * **per-symbol** predicate (0240's `runAccountSetup().isReady`, which marks a symbol
   * whose `setLeverage` failed untradable → preflight `account_setup_incomplete`).
   * Defaults to `() => true` — existing callers/goldens untouched.
   */
  readonly accountSetupComplete?: boolean | ((symbol: string) => boolean)
  /** Reconciliation sink invoked after `CLOSED` (composition logs the diff; no throw on mismatch). */
  readonly onReconciliation?: (record: ReconciliationRecord) => void
}

/**
 * The optional WAL fields carried on an intent's transitions — the exact set
 * crash recovery reads back to rebuild the deterministic order id, entry
 * side/qty/fill, deadline + settlement instants, and the funding-accrual verdict
 * from the WAL alone.
 */
export interface IntentWalFields {
  readonly clientOrderId?: string
  readonly entrySide?: Side
  readonly entryQty?: number
  readonly entryFillPx?: number
  readonly tDeadlineMs?: number
  /** Settlement instant the intent entered against, epoch ms — the `timed` exit's anchor (`01` §3). */
  readonly tSettleMs?: number
  /** Funding-accrual verdict (`00_globals.md` §3.1): entry fill landed before `T_settle`, so the position accrues. */
  readonly fundingReceived?: boolean
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

/** The reconciliation placeholder's finding: engine fill record vs venue ground truth (`15`, real reconciliation 0400). */
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
  /** Funding-accrual verdict (`00_globals.md` §3.1) for an intent, or `undefined` if unknown/not yet monitoring. */
  fundingReceived(intentId: string): boolean | undefined
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
  /** Instant the entry filled (MONITORING entry), epoch ms — the exit policy's `enteredAtMs`. */
  enteredAtMs?: number
  /** Settlement instant this intent entered against, epoch ms — the `timed` exit's anchor (`01` §3). */
  settleTs?: number
  /** Funding-accrual verdict (`00_globals.md` §3.1): entry fill landed before `T_settle`. Set on `→ MONITORING`. */
  fundingReceived?: boolean
  /** Reference price at entry-decision time (`latestPrice` at `onEntry`) — S2's retracement anchor (`03` §2). In-memory only. */
  anchorPrice?: number
  /** Realized predicted funding rate the intent entered on, signed percent — S3a's TP `|F|` source (`04` §3). In-memory only. */
  ratePercent?: number
  deadlineMs?: number
  /** Exit reason the exit-policy handler commanded (stashed on `→ EXITING`, recorded on `→ CLOSED`). */
  exitReason?: ExitReason
  /** Advisory cost-model breakdown captured at selection (task 0150); in-memory analytics only, never WAL'd. */
  costBreakdown?: ProfitBreakdown
}

/**
 * `pendingOrders` value: which intent/leg a `clientOrderId` belongs to. `exit-policy`
 * is a handler-owned resting reduce-only leg (S2's SL/TP); the post-exit sweep cancels
 * it and its updates route to `exitHandler.onOrderUpdate`.
 */
interface PendingOrder {
  readonly intentId: string
  readonly leg: 'entry' | 'exit' | 'exit-policy'
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
      tSettleMs: payload.tSettleMs,
      fundingReceived: payload.fundingReceived,
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
  const { bus, clock, scheduler, exchange, wal, repo, registry, strategyConfig, exitPolicyRegistry } = deps
  // Direction-driven trade side (`04` §1: S3a is the first SHORT strategy). `direction`
  // (`negative`/`positive`) is the funding-ordering family — orthogonal to the trade side;
  // long-only strategies leave `entrySide` unset and are byte-unchanged (default `long`).
  const entrySide: Side = strategyConfig.entrySide ?? 'long'
  /** Reduce-only close is the opposite of the entry side. */
  const exitSide: Side = entrySide === 'long' ? 'short' : 'long'
  const riskGate: RiskGate = deps.riskGate ?? { check: () => ({ allowed: true }) }
  const killSwitch = deps.killSwitch ?? { state: (): KillSwitchState => 'off' }
  // Resolve the setup-readiness input to a uniform per-symbol predicate (bool → constant fn).
  const accountSetupReady: (symbol: string) => boolean =
    typeof deps.accountSetupComplete === 'function'
      ? deps.accountSetupComplete
      : (
          (ready: boolean) => () =>
            ready
        )(deps.accountSetupComplete ?? true)
  // Fail loud on misconfiguration: an id with no registered module is a startup bug, not a runtime skip.
  const activeModule = resolveModule(registry, strategyConfig.id)
  // Registry-driven exit dispatch (`12` §5): resolve the one handler for the active
  // module's kind — a declared-but-unregistered kind is a startup bug, not a runtime skip.
  const resolvedHandler = exitPolicyRegistry.get(activeModule.exitPolicyKind)
  if (resolvedHandler === undefined) {
    throw new Error(`Engine: no exit-policy handler registered for kind '${activeModule.exitPolicyKind}'`)
  }
  const exitHandler: ExitPolicyHandler = resolvedHandler
  // The port subset a handler arms against — scheduler + clock + the out-of-band exit
  // seam — bound once. `requestExit` is the gated-policy seam (`funding_fee_event`,
  // S1-WS/S2/S6): a gate signal resolving outside `onEvent` dispatch fires the exit here,
  // guarded on `MONITORING` so a duplicate/late signal is idempotent (the gate opens once).
  const exitCtx: ExitPolicyContext = {
    scheduleDeadline: (intentId, atMs) => void scheduler.scheduleDeadlineTimer(intentId, atMs),
    now: () => clock.now(),
    requestExit: (intentId, exitReason) => {
      const rec = intents.get(intentId)
      if (rec?.state === 'MONITORING') fireExit(intentId, rec, exitReason)
    },
    placeExitLeg: (intentId, req) => placeExitLeg(intentId, req),
    cancelExitLeg: (clientOrderId) => {
      pendingOrders.delete(clientOrderId)
      // Best-effort: a since-filled/unknown order throws; the order manager reconciles by
      // venue truth on a cancel/fill race (`03` line 21).
      void exchange.cancelOrder(clientOrderId).catch(() => {})
    },
    confirmClose: (intentId, exitReason, filledClientOrderId) => {
      const rec = intents.get(intentId)
      if (rec?.state !== 'MONITORING') return // idempotent: a raced/late close no-ops
      rec.exitReason = exitReason
      pendingOrders.delete(filledClientOrderId)
      // Fill already in hand: MONITORING → EXITING → CLOSED in one step, then sweep the sibling.
      commit({
        intentId,
        symbol: rec.symbol,
        from: 'MONITORING',
        to: 'EXITING',
        payload: {},
        extras: { clientOrderId: filledClientOrderId },
      })
      closeFromExiting(intentId, rec, exitReason)
    },
  }

  const intents = new Map<string, IntentRecord>()
  const pendingOrders = new Map<string, PendingOrder>()
  const predicted = new Map<string, FundingPredicted>()
  // Settlement instant per symbol, stashed at selection (`onScan`) and read at entry
  // (`onEntry`) — the `timed` exit's anchor, mirroring the `predicted`/`costBySymbol` maps.
  const settleBySymbol = new Map<string, number>()
  // Realized predicted funding rate per symbol, stashed at selection and read at entry — S3a's
  // TP is scaled by the realized `|F|` the intent entered on, not the selection threshold (`04`
  // §3; the threshold proxy would sit the TP too shallow to cover the funding cost). In-memory
  // only (mirrors `settleBySymbol`); no WAL field, so s1/s1-ws/s2 goldens are untouched (0370 re-derives).
  const rateBySymbol = new Map<string, number>()
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
      // Stash the settlement instant for `onEntry` to thread into the intent (the
      // `timed` exit anchors on it, not fill time — `01` §3).
      settleBySymbol.set(trigger.symbol, trigger.settleTs)
      // Stash the realized predicted rate too — S3a's TP scales off it (`04` §3).
      rateBySymbol.set(trigger.symbol, candidate.ratePercent)
      // Entry timer fires `entryOffsetSeconds` before settlement (`00_globals.md` §7).
      scheduler.scheduleEntryTimer(trigger.symbol, trigger.settleTs - strategyConfig.entryOffsetSeconds * 1000)
    }
  }

  /** Build the preflight snapshot for `symbol` from the engine's current venue view, sized to `qty`. */
  function preflightSnapshot(symbol: string, qty: number): PreflightSnapshot {
    const market = exchange.markets().find((m) => m.normalized === symbol)
    return {
      killSwitch: killSwitch.state(),
      openIntentCount: countLiveIntents(),
      breakerOpen: false, // hardcoded until circuit breakers land (0380).
      amountUsd: strategyConfig.amountUsd,
      leverage: strategyConfig.leverage,
      balance: latestBalance,
      qty,
      price: latestPrice.get(symbol),
      instrument: exchange.normalize(symbol),
      accountSetupComplete: accountSetupReady(symbol),
      marketStatus: market?.status ?? 'delisted',
    }
  }

  function onEntry(event: Timer): void {
    const symbol = event.symbol
    if (symbol === undefined) return
    const intentId = `${symbol}-${event.ts}`

    // Real sizing (`00_globals.md` §4): `amountUsd / price → qty`, lot-floored. An unknown
    // price yields qty 0, which preflight skips (fail-closed) — same verdict as an
    // infeasible size; there is no `error_code` for min-notional, so both leave no trace.
    const price = latestPrice.get(symbol)
    const qty = price === undefined ? 0 : computeQty(strategyConfig.amountUsd, price, exchange.normalize(symbol))

    // Preflight before creating the intent row: `skip` leaves no trace (`12` §3 / `13` §6).
    const result = runPreflight(preflightSnapshot(symbol, qty), riskGate, symbol)
    if (result.kind === 'skip') return

    const rec: IntentRecord = {
      symbol,
      state: 'SELECTED',
      entrySide,
      entryQty: qty,
      settleTs: settleBySymbol.get(symbol),
      // Reference price at entry-decision time (`03` §2 R8): the retracement anchor S2 trails
      // toward. Captured here (≈ best ask ≈ latest price at entry), held in-memory only.
      anchorPrice: price,
      // Realized predicted rate the intent entered on — S3a's TP `|F|` source (`04` §3). In-memory only.
      ratePercent: rateBySymbol.get(symbol),
    }
    const stashedCost = costBySymbol.get(symbol)
    if (stashedCost !== undefined) rec.costBreakdown = stashedCost
    intents.set(intentId, rec)

    if (result.kind === 'reject') {
      commit({ intentId, symbol, from: 'SELECTED', to: 'ABORTED', payload: { errorCode: result.errorCode } })
      return
    }

    const clientOrderId = makeClientOrderId({ intentId, leg: 'entry', attempt: 1 })
    commit({
      intentId,
      symbol,
      from: 'SELECTED',
      to: 'SUBMITTING_ENTRY',
      payload: {},
      // `tSettleMs` rides from here on so a crash before the fill still recovers the
      // settlement anchor the `timed` exit arms against (SUBMITTING_ENTRY → re-submit → fill).
      extras: { clientOrderId, entrySide: rec.entrySide, entryQty: rec.entryQty, tSettleMs: rec.settleTs },
    })
    pendingOrders.set(clientOrderId, { intentId, leg: 'entry' })
    void exchange.placeOrder({ symbol, side: rec.entrySide, type: 'market', qty: rec.entryQty, clientOrderId })
  }

  /** Project a MONITORING intent record into the read-only shape the exit policy observes. */
  function toMonitoredIntent(intentId: string, rec: IntentRecord): MonitoredIntent {
    return {
      intentId,
      symbol: rec.symbol,
      entrySide: rec.entrySide,
      entryQty: rec.entryQty,
      entryFillPx: rec.entryFillPx,
      entryFillQty: rec.entryFillQty,
      enteredAtMs: rec.enteredAtMs ?? clock.now(),
      settleTs: rec.settleTs,
      deadlineMs: rec.deadlineMs,
      anchorPrice: rec.anchorPrice,
      ratePercent: rec.ratePercent,
    }
  }

  /** MONITORING intents an event targets: a deadline Timer → its one intent; a symbol event → all on that symbol. */
  function exitTargets(event: MonitoredEvent): Array<[string, IntentRecord]> {
    if (event.type === 'Timer') {
      const intentId = event.intentId
      if (intentId === undefined) return []
      const rec = intents.get(intentId)
      return rec ? [[intentId, rec]] : []
    }
    const targets: Array<[string, IntentRecord]> = []
    for (const [intentId, rec] of intents) {
      if (rec.state === 'MONITORING' && rec.symbol === event.symbol) targets.push([intentId, rec])
    }
    return targets
  }

  /** Fire the reduce-only exit for an intent the exit policy commanded closed. */
  function fireExit(intentId: string, rec: IntentRecord, exitReason: ExitReason): void {
    const clientOrderId = makeClientOrderId({ intentId, leg: 'exit', attempt: 1 })
    rec.exitReason = exitReason
    commit({ intentId, symbol: rec.symbol, from: 'MONITORING', to: 'EXITING', payload: {}, extras: { clientOrderId } })
    pendingOrders.set(clientOrderId, { intentId, leg: 'exit' })
    void exchange.placeOrder({
      symbol: rec.symbol,
      side: exitSide,
      type: 'market',
      qty: rec.entryQty,
      clientOrderId,
      reduceOnly: true,
    })
  }

  /**
   * Place a handler-owned resting reduce-only leg (S2's SL stop / trailing TP limit).
   * The engine assigns the deterministic id, rounds the price to the venue tick, caps the
   * qty to the entry fill, and tracks it as an `exit-policy` leg — the intent stays
   * MONITORING (a resting leg is not itself an exit). Returns the assigned `clientOrderId`.
   */
  function placeExitLeg(intentId: string, req: ExitLegRequest): string {
    const rec = intents.get(intentId)
    if (rec === undefined) throw new Error(`Engine: placeExitLeg for unknown intent '${intentId}'`)
    const clientOrderId = makeClientOrderId({ intentId, leg: req.leg, attempt: req.attempt })
    const instrument = exchange.normalize(rec.symbol)
    const price = req.price === undefined ? undefined : roundPrice(req.price, instrument)
    const qty = capReduceOnlyQty(req.qty, rec.entryFillQty ?? rec.entryQty)
    pendingOrders.set(clientOrderId, { intentId, leg: 'exit-policy' })
    void exchange.placeOrder({
      symbol: rec.symbol,
      side: exitSide,
      type: req.type,
      qty,
      price,
      clientOrderId,
      reduceOnly: true,
    })
    return clientOrderId
  }

  /** Record `→ CLOSED`, sweep any sibling reduce-only legs, and reconcile — the shared exit tail. */
  function closeFromExiting(intentId: string, rec: IntentRecord, exitReason: ExitReason): void {
    commit({ intentId, symbol: rec.symbol, from: 'EXITING', to: 'CLOSED', payload: { exitReason } })
    // Post-exit reduce-only sweep (`00_globals.md` §5.2, `01` §2 step 5): cancel the sibling
    // legs still tracked open for this symbol (S2's SL/TP OCO); no-op on S1's market-exit path.
    sweepReduceOnlyOrders(intentId, rec.symbol)
    void finishReconciliation(intentId)
  }

  /** Route one MONITORING event through the active exit-policy handler; fire the exit on a decision (`12` §5). */
  function dispatchToExitPolicy(event: MonitoredEvent): void {
    for (const [intentId, rec] of exitTargets(event)) {
      if (rec.state !== 'MONITORING') continue
      const decision = exitHandler.onEvent(event, toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
      if (decision !== undefined) fireExit(intentId, rec, decision.exitReason)
    }
  }

  function onTimer(event: Timer): void {
    if (event.kind === 'scan') onScan(event)
    else if (event.kind === 'entry') onEntry(event)
    else dispatchToExitPolicy(event)
  }

  /** Adopt an entry fill (real update or recovered-and-confirmed): record it and advance to `MONITORING`. */
  function adoptEntryFill(
    intentId: string,
    rec: IntentRecord,
    fillPx: number | undefined,
    fillQty: number | undefined,
  ): void {
    rec.entryFillPx = fillPx
    rec.entryFillQty = fillQty
    // On the live path `deadlineMs` is undefined here → the handler derives it from
    // `settleTs + exitOffsetSeconds`; on crash-recovery re-arm it is the recovered instant.
    rec.enteredAtMs = rec.enteredAtMs ?? clock.now()
    // Funding-accrual verdict (`00_globals.md` §3.1): the position accrues iff the entry
    // filled before settlement. Recorded in the WAL payload (not yet an `intents` column;
    // that + a trades table are 0360/0390) so scenarios/e2e assert it from the WAL.
    const fundingReceived = rec.settleTs === undefined ? undefined : rec.enteredAtMs < rec.settleTs
    rec.fundingReceived = fundingReceived
    const deadlineMs = exitHandler.arm(toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
    rec.deadlineMs = deadlineMs
    commit({
      intentId,
      symbol: rec.symbol,
      from: 'SUBMITTING_ENTRY',
      to: 'MONITORING',
      payload: {},
      extras: {
        entrySide: rec.entrySide,
        entryQty: rec.entryQty,
        entryFillPx: fillPx,
        tDeadlineMs: deadlineMs,
        tSettleMs: rec.settleTs,
        fundingReceived,
      },
    })
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
    // The exit reason was stashed by the exit-policy handler on `→ EXITING`; a fill
    // with none recorded is a broken invariant, not a default (fail loud).
    const exitReason = rec.exitReason
    if (exitReason === undefined) throw new Error(`Engine: exit fill for '${intentId}' has no recorded exit reason`)
    closeFromExiting(intentId, rec, exitReason)
  }

  /** Route an update on a handler-owned resting leg (S2's SL/TP) to the exit policy; a fill drives the OCO close. */
  function onExitPolicyOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    if (rec.state !== 'MONITORING') return
    exitHandler.onOrderUpdate?.(event, toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
  }

  /**
   * Cancel reduce-only (exit-leg) orders the engine still tracks open for `symbol`.
   * Engine-tracked only: a venue-side sweep needs a `getOpenOrders` port the adapter
   * interface lacks (logged as a SUGGESTION); full stale-sweep-before-entry is 0380.
   */
  function sweepReduceOnlyOrders(intentId: string, symbol: string): void {
    for (const [clientOrderId, pending] of [...pendingOrders]) {
      if (pending.leg !== 'exit' && pending.leg !== 'exit-policy') continue
      if (intents.get(pending.intentId)?.symbol !== symbol) continue
      pendingOrders.delete(clientOrderId)
      // Best-effort: a since-filled/unknown order throws — swallow it, the intent is CLOSED.
      void exchange.cancelOrder(clientOrderId).catch(() => {})
    }
    void intentId // referenced for symmetry with the persisted intent scope; no per-intent state to clear.
  }

  function onOrderUpdate(event: OrderUpdate): void {
    const pending = pendingOrders.get(event.clientOrderId)
    if (!pending) return
    const rec = intents.get(pending.intentId)
    if (!rec) return
    if (pending.leg === 'entry') onEntryOrderUpdate(event, pending.intentId, rec)
    else if (pending.leg === 'exit') onExitOrderUpdate(event, pending.intentId, rec)
    else onExitPolicyOrderUpdate(event, pending.intentId, rec)
  }

  /** Reconciliation placeholder: compare the engine's recorded entry fill against venue ground truth; log, never throw (0400 replaces). */
  async function finishReconciliation(intentId: string): Promise<void> {
    const rec = intents.get(intentId)
    if (!rec) return
    const engineQty = rec.entryFillQty ?? rec.entryQty
    let venueQty = 0
    try {
      const order = await exchange.getOrder(makeClientOrderId({ intentId, leg: 'entry', attempt: 1 }))
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
      // Latest price/balance feed the preflight snapshot (`12` §3); the tick also
      // reaches the exit policy (a MONITORING event) via the registry.
      case 'MarketTick':
        latestPrice.set(event.symbol, event.price)
        dispatchToExitPolicy(event)
        return
      case 'BalanceUpdate':
        latestBalance = { asset: event.asset, free: event.free, used: event.used }
        return
      // The funding-fee accrual is a MONITORING event — route it through the exit policy.
      case 'FundingFeeAccrued':
        dispatchToExitPolicy(event)
        return
      // Not consumed by the skeleton yet — explicit no-ops keep the switch exhaustive.
      case 'FundingSettled':
      case 'PositionUpdate':
      // Orphan handling is the risk layer's job (0380), which subscribes directly.
      case 'OrphanDetected':
        return
      default:
        assertNever(event)
    }
  }

  async function recoverSubmitting(r: RecoveredIntent): Promise<void> {
    const rec: IntentRecord = {
      symbol: r.symbol,
      state: 'SUBMITTING_ENTRY',
      entrySide: r.entrySide ?? entrySide,
      entryQty: r.entryQty ?? 0,
      settleTs: r.tSettleMs,
    }
    intents.set(r.intentId, rec)
    const clientOrderId = r.clientOrderId ?? makeClientOrderId({ intentId: r.intentId, leg: 'entry', attempt: 1 })

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
      entrySide: r.entrySide ?? entrySide,
      entryQty: r.entryQty ?? 0,
      entryFillPx: r.entryFillPx,
      settleTs: r.tSettleMs,
      fundingReceived: r.fundingReceived,
      deadlineMs: r.tDeadlineMs,
    }
    intents.set(r.intentId, rec)
    // Reconcile qty against venue ground truth — do NOT replace the live order.
    const positions = await exchange.getPositions()
    rec.entryFillQty = positions.find((p) => p.symbol === r.symbol)?.qty ?? r.entryQty
    // Re-arm through the handler: passing the recovered `deadlineMs` makes the timed
    // policy schedule at the recovered instant, not `now + holdMs`.
    if (r.tDeadlineMs !== undefined) exitHandler.arm(toMonitoredIntent(r.intentId, rec), strategyConfig, exitCtx)
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
    fundingReceived(intentId: string): boolean | undefined {
      return intents.get(intentId)?.fundingReceived
    },
    dispose(): void {
      exitHandler.dispose?.() // release handler-owned resources (the funding gate's timers, S1-WS)
      unsubscribe()
    },
  }
}
