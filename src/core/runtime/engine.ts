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

import type { StrategyId } from '../../config/canonical.js'
import type { KillSwitchState } from '../../config/env.js'
import {
  assertNever,
  type EngineEvent,
  type FundingFeeAccrued,
  type FundingPredicted,
  type OrderUpdate,
  type Timer,
} from '../events/types.js'
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
import type { Repo, TrackerSnapshotRecord } from '../ports/repo.js'
import type { RiskGate } from '../ports/risk-gate.js'
import type { TransitionLog, TransitionLogEntry } from '../ports/transition-log.js'
import { capReduceOnlyQty, computeQty, minFeasibleQty, roundPrice, splitLadder } from '../sizing/sizing.js'
import type {
  LadderEntryPlan,
  RuntimeStrategyConfig,
  StrategyModule,
  StrategyRegistry,
} from '../strategies/registry.js'
import { type ConditionalStop, isTriggered } from './conditional-stop.js'
import { evaluateProfitCondition, type ProfitBreakdown } from './cost-model.js'
import type { EntryContext, EntrySubMachine } from './entry-submachine.js'
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
  /**
   * Kill-switch state source read in preflight (`13` §2). Defaults to `off`. When it carries
   * `subscribe` (the real {@link ../../risk/kill-switch.js}.KillSwitch, 0380), the engine also
   * listens for `flatten`: on that transition it fires every MONITORING intent's reduce-only exit
   * with `exitReason: 'kill_switch_flatten'` so the intent rows reach `CLOSED(kill_switch_flatten)`.
   */
  readonly killSwitch?: {
    state(): KillSwitchState
    subscribe?(fn: (state: KillSwitchState) => void): Unsubscribe
  }
  /**
   * Circuit-breaker consultation for preflight (`13` §3, 0380) — the venue-io breaker's
   * `isOpen()`. Consulted **only** at the new-intent entry paths, so a breaker opening
   * mid-position blocks new entries but never abandons an open one. Defaults to `() => false`
   * (existing callers/goldens byte-unchanged).
   */
  readonly breakerOpen?: () => boolean
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
  /**
   * Diagnostic ops-event sink (mirrors {@link onReconciliation}) — the ladder's
   * `ladder.pre_funding_fill` (`05` §2 step 2). Composition logs it + writes a trace record;
   * absent ⇒ the engine emits nothing.
   */
  readonly onOpsEvent?: (event: OpsEvent) => void
  /**
   * Post-trade accounting sink (`15` §1, 0390) — fired at every terminal `commit` that ends a
   * managed lifecycle: `CLOSED` (a position existed) and `NO_POSITION` (none did). Mirrors the
   * {@link onReconciliation}/{@link onOpsEvent} escape hatches. The sidecar assembles the `pnl`
   * row from the in-memory {@link TradeCloseContext} projection + a `funding_events` read. Absent
   * ⇒ the engine emits nothing (existing callers/goldens untouched).
   */
  readonly onTradeClose?: (ctx: TradeCloseContext) => void
  /**
   * Config revision hash (`09` §7) stamped onto every persisted intent (`IntentSnapshot.configHash`)
   * — the fail-loud boot check (0370 `recovery.ts`) compares a recovered intent's stored hash
   * against the *current* boot's before touching the venue. Absent ⇒ `configHash` stays
   * unset (pre-0370 callers/tests untouched).
   */
  readonly configHash?: string
}

/** A diagnostic engine ops event surfaced via {@link EngineDeps.onOpsEvent} (`05` §2 step 2, `07` §3). */
export interface OpsEvent {
  /**
   * The diagnostic events the engine surfaces:
   *  - `ladder.pre_funding_fill` — a ladder rung filled before `T_settle` (S4.1a `05` §2 step 2);
   *  - `strategy6.close_pre_funding_failed` — S6's abort ladder could not flatten PRE (orphan risk, `07` §3);
   *  - `strategy6.position_fetch_fallback` — S6's REST net-qty confirm failed; tracked fills used (`07` §2 step 4).
   */
  readonly kind: 'ladder.pre_funding_fill' | 'strategy6.close_pre_funding_failed' | 'strategy6.position_fetch_fallback'
  readonly intentId: string
  readonly symbol: string
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
  /** Settled funding rate at MAIN fill, signed percent — S6's TP/SL `|F|` source (`07` §2 step 4). Absent for other strategies. */
  readonly settledRatePercent?: number
  /**
   * The exit reason a `MONITORING → EXITING` transition was fired for (`fireExit`), carried
   * ahead of the terminal `CLOSED{exitReason}` payload so a crash mid-flight still recovers
   * *why* the exit leg was placed (`14` §5 full matrix, 0370) — without it a recovered
   * `EXITING` intent has no legal value to close with (R12 requires one). Absent on every
   * other transition (JSON drops `undefined`; earlier goldens byte-unchanged).
   */
  readonly exitReason?: ExitReason
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

/**
 * The realized-fact projection handed to {@link EngineDeps.onTradeClose} at a terminal
 * `commit` (`15` §1, 0390) — the in-memory `IntentRecord` snapshot the accounting sidecar
 * turns into a `pnl` row (via `core/accounting/trade-record.ts`). Prices/qty are realized
 * fills; `settledFundingAmount` is read from `funding_events` by the sidecar, not carried here.
 */
export interface TradeCloseContext {
  readonly intentId: string
  readonly symbol: string
  readonly strategyId: StrategyId
  readonly entrySide: Side
  /** Set on a CLOSED terminal; absent on NO_POSITION. */
  readonly exitReason?: ExitReason
  /** Set on a NO_POSITION terminal; absent on CLOSED. */
  readonly errorCode?: ErrorCode
  /** Single-entry fill price (non-ladder). */
  readonly pEntry?: number
  /** Closing fill price. */
  readonly pExit?: number
  /** Fill-weighted average entry (ladder). */
  readonly pAvg?: number
  readonly entryQty: number
  /** Realized filled qty (ladder aggregate; the reduce-only exit cap). */
  readonly filledQty?: number
  /** Number of entry fills (ladder rungs filled; 1 for a single entry, 0 if none). */
  readonly fillCount: number
  /** Funding-accrual verdict (`00_globals` §3.1). */
  readonly fundingReceived: boolean
  readonly enteredAtMs?: number
  readonly closedAtMs: number
  readonly tSettleMs?: number
  /** `T_drop − T_settle`, seconds; null when no `T_drop` was observed. */
  readonly tDropOffsetS?: number
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
  /**
   * Rebuild in-memory state from recovered intents and re-drive them (call before advancing
   * the clock). `snapshots` are the durable `tracker_snapshots` rows (0370 `recovery.ts`
   * step 3); a handler that owns snapshot restore (S2's retracement tracker) is fed the ones
   * matching its live records before any per-intent re-arm.
   */
  recover(recovered: readonly RecoveredIntent[], snapshots?: readonly TrackerSnapshotRecord[]): Promise<void>
  /** Current FSM state of an intent, or `undefined` if unknown to this engine. */
  intentState(intentId: string): IntentState | undefined
  /** Count of live (non-terminal) intents — the order-breaker feed's `hasLiveIntent` input (`13` §3, 0380). */
  liveIntentCount(): number
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
  /** Settled funding rate at MAIN fill, signed percent — S6's TP/SL `|F|` source (`07` §2 step 4). Set on `→ MONITORING`. */
  settledRatePercent?: number
  /** `T_drop − T_settle`, seconds (`00_globals` §8.3) — set when the `FundingFeeAccrued` (T_drop) is observed. Accounting only (0390). */
  tDropOffsetS?: number
  deadlineMs?: number
  /** Exit reason the exit-policy handler commanded (stashed on `→ EXITING`, recorded on `→ CLOSED`). */
  exitReason?: ExitReason
  /** Advisory cost-model breakdown captured at selection (task 0150); in-memory analytics only, never WAL'd. */
  costBreakdown?: ProfitBreakdown
  /**
   * Ladder entry state (S4.1a, `05` §2). Present ⇒ this is a ladder intent. In-memory only
   * (NOT WAL'd; 0370 re-derives): the N rung orders, the precomputed full-ladder `P_avg_full`
   * the engine-side SL anchors on, and the running fill aggregates that drive `entryFillPx`/`entryFillQty`.
   */
  ladderRungs?: LadderRung[]
  pAvgFull?: number
  /** Running Σ filled base qty across rungs. */
  filledQty?: number
  /** Running Σ (fill price · qty) across rungs — divided by {@link filledQty} for `P_avg`. */
  filledNotional?: number
}

/** One ladder rung's engine bookkeeping: its client order id, target price/qty, and whether it filled. */
interface LadderRung {
  readonly coid: string
  readonly price: number
  readonly qty: number
  filled: boolean
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
      settledRatePercent: payload.settledRatePercent,
      exitReason: payload.exitReason,
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

/**
 * S6 entry terminals whose position outcome is "none" (order submit/reject) → `ENTRY_FAILED`
 * (`07` §3). Every other S6 terminal (`pre_funding_not_filled` / `funding_event_timeout` /
 * `close_pre_funding_failed`) is a position-was-flattened outcome → `NO_POSITION`.
 */
const S6_ENTRY_FAILED_CODES: ReadonlySet<ErrorCode> = new Set([
  'pre_funding_order_failed',
  'pre_funding_order_rejected',
  'main_order_failed',
  'main_order_rejected',
])

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
  const breakerOpen: () => boolean = deps.breakerOpen ?? (() => false)
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
  // Engine-side conditional stops (S4.1a), armed at ladder placement, evaluated on every
  // `MarketTick`, disarmed on any exit (`05` §2 step 1). In-memory only (0370 re-derives).
  const conditionalStops = new Map<string, ConditionalStop>()
  // Last exit-leg fill price per intent — stashed when an exit / exit-policy fill arrives so the
  // terminal `onTradeClose` hook can book `pExit` without threading it through the OCO close path
  // (accounting only, 0390; in-memory, never WAL'd).
  const exitFillPxByIntent = new Map<string, number>()
  const predicted = new Map<string, FundingPredicted>()
  // Settlement instant per symbol, stashed at selection (`onScan`) and read at entry
  // (`onEntry`) — the `timed` exit's anchor, mirroring the `predicted`/`costBySymbol` maps.
  const settleBySymbol = new Map<string, number>()
  // Realized predicted funding rate per symbol, stashed at selection and read at entry — S3a's
  // TP is scaled by the realized `|F|` the intent entered on, not the selection threshold (`04`
  // §3; the threshold proxy would sit the TP too shallow to cover the funding cost). In-memory
  // only (mirrors `settleBySymbol`); no WAL field, so s1/s1-ws/s2 goldens are untouched (0370 re-derives).
  const rateBySymbol = new Map<string, number>()
  // Settled funding rate per symbol, stashed on `FundingSettled` and read at S6's `enterMonitoring` —
  // S6's OCO geometry is computed at MAIN fill from the SETTLED `|F|`, not the predicted rate (`07` §2
  // step 4). In-memory only (mirrors `rateBySymbol`); WAL'd onto the intent only when present (0370 re-derives).
  const settledRateBySymbol = new Map<string, number>()
  // Advisory cost-model breakdown per symbol, stashed at selection, copied onto the intent at entry (task 0150).
  const costBySymbol = new Map<string, ProfitBreakdown>()
  // Latest venue state the preflight reads, updated from the event stream.
  let latestBalance: Balance | undefined = deps.initialBalance
  const latestPrice = new Map<string, number>()

  // S6 entry sub-machine (`07` §2/§3): present ⇒ the engine delegates the whole `SUBMITTING_ENTRY`
  // phase to it via `entryCtx`. Instantiated once so each engine owns its gate + per-intent state.
  const entrySubMachine: EntrySubMachine | undefined = activeModule.entrySubMachine?.()
  // The order-command seam the sub-machine drives (entry-side analogue of `exitCtx`). The engine
  // assigns deterministic ids, tracks the legs, WALs the transitions, and owns the FSM.
  const entryCtx: EntryContext = {
    placePreFunding(intentId, qty): string {
      const rec = requireIntent(intentId)
      const clientOrderId = makeClientOrderId({ intentId, leg: 'pre', attempt: 1 })
      pendingOrders.set(clientOrderId, { intentId, leg: 'entry' })
      // PRE is at `exitSide` (opposite the managed direction) and NOT reduce-only (it opens the tiny
      // position that subscribes the private WS — `07` §2 step 1).
      void exchange.placeOrder({ symbol: rec.symbol, side: exitSide, type: 'market', qty, clientOrderId })
      return clientOrderId
    },
    placeMain(intentId, qty): string {
      const rec = requireIntent(intentId)
      const clientOrderId = makeClientOrderId({ intentId, leg: 'main', attempt: 1 })
      pendingOrders.set(clientOrderId, { intentId, leg: 'entry' })
      // MAIN is at `entrySide` (the managed direction); its qty > PRE reverses the net position (`07` §2 step 3).
      void exchange.placeOrder({ symbol: rec.symbol, side: entrySide, type: 'market', qty, clientOrderId })
      return clientOrderId
    },
    placeAbortClose(intentId, attempt, qty): void {
      const rec = requireIntent(intentId)
      const clientOrderId = makeClientOrderId({ intentId, leg: 'preabort', attempt })
      // Fire-and-forget reduce-only close at `entrySide` (closes the opposite PRE leg). Not tracked in
      // `pendingOrders` — the abort ladder is driven by REST ground truth, not this order's update.
      void exchange.placeOrder({
        symbol: rec.symbol,
        side: entrySide,
        type: 'market',
        qty,
        clientOrderId,
        reduceOnly: true,
      })
    },
    getPositions: () => exchange.getPositions(),
    enterMonitoring(intentId, netQty, entryPx): void {
      const rec = intents.get(intentId)
      if (rec === undefined || rec.state !== 'SUBMITTING_ENTRY') return // idempotent: a raced/late confirm no-ops
      dropEntryOrders(intentId)
      // Stash the settled `|F|` the OCO geometry anchors on (`07` §2 step 4), threaded onto the intent
      // by `adoptEntryFill`. Absent for a symbol with no `FundingSettled` yet → geometry falls back.
      rec.settledRatePercent = settledRateBySymbol.get(rec.symbol)
      adoptEntryFill(intentId, rec, entryPx, netQty)
    },
    failEntry(intentId, errorCode): void {
      const rec = intents.get(intentId)
      if (rec === undefined || rec.state !== 'SUBMITTING_ENTRY') return // idempotent
      dropEntryOrders(intentId)
      const to: IntentState = S6_ENTRY_FAILED_CODES.has(errorCode) ? 'ENTRY_FAILED' : 'NO_POSITION'
      commit({ intentId, symbol: rec.symbol, from: 'SUBMITTING_ENTRY', to, payload: { errorCode } })
      // Accounting books the NO_POSITION terminal (zero economics); ENTRY_FAILED/ABORTED are not
      // managed-lifecycle closes, so the hook covers only NO_POSITION (`15` §1, 0390).
      if (to === 'NO_POSITION') fireTradeClose(intentId, rec, { errorCode })
    },
    emitOps(event): void {
      deps.onOpsEvent?.(event)
    },
  }

  /** Look up an intent the sub-machine is placing an order for, or fail loud — an unknown id is a wiring bug. */
  function requireIntent(intentId: string): IntentRecord {
    const rec = intents.get(intentId)
    if (rec === undefined) throw new Error(`Engine: entry sub-machine referenced unknown intent '${intentId}'`)
    return rec
  }

  /** Drop this intent's tracked entry legs (PRE/MAIN) from `pendingOrders` on a terminal / MONITORING handoff. */
  function dropEntryOrders(intentId: string): void {
    for (const [clientOrderId, pending] of [...pendingOrders]) {
      if (pending.intentId === intentId && pending.leg === 'entry') pendingOrders.delete(clientOrderId)
    }
  }

  /** Count of live (non-terminal) intents — the risk gate's concurrency input. */
  function countLiveIntents(): number {
    let count = 0
    for (const rec of intents.values()) if (!TERMINAL_INTENT_STATES.includes(rec.state)) count++
    return count
  }

  /** ≤ 1 tracker-snapshot write per second per intent — mirrors S2's TP re-place throttle (`03` §5). */
  const SNAPSHOT_THROTTLE_MS = 1000
  const lastSnapshotWriteMs = new Map<string, number>()

  /**
   * The one exit-policy kind with deep crash-recovery snapshot support (S2's retracement
   * tracker, 0370 decision #2) — feature-detected since {@link ExitPolicyHandler} stays
   * generic (`RetracementHandler` adds `serialize`/`restore` beyond the base interface).
   * S3a/S4/S6's static-OCO handlers have neither, so they fall back to a blind re-arm on
   * recovery (SUGGESTIONS: their deep snapshot support is deferred).
   */
  interface SnapshotCapableHandler extends ExitPolicyHandler {
    serialize(): ReadonlyArray<{ readonly intentId: string }>
    restore(snapshots: readonly unknown[]): void
  }
  function isSnapshotCapable(h: ExitPolicyHandler): h is SnapshotCapableHandler {
    const maybe = h as Partial<SnapshotCapableHandler>
    return typeof maybe.serialize === 'function' && typeof maybe.restore === 'function'
  }

  /**
   * Durably persist `intentId`'s tracker snapshot (`tracker_snapshots`, `14` §7) — the
   * `repo.upsertTrackerSnapshot` write recovery's `loadTrackerSnapshots` reads back. No-op
   * when the active handler carries no deep snapshot, the repo omits the optional writer
   * (in-memory test repo), or (absent `force`) the last write was under {@link
   * SNAPSHOT_THROTTLE_MS} ago.
   */
  function maybeWriteTrackerSnapshot(intentId: string, force = false): void {
    if (repo.upsertTrackerSnapshot === undefined) return
    if (!isSnapshotCapable(exitHandler)) return
    const now = clock.now()
    if (!force) {
      const last = lastSnapshotWriteMs.get(intentId)
      if (last !== undefined && now - last < SNAPSHOT_THROTTLE_MS) return
    }
    const snapshot = exitHandler.serialize().find((s) => s.intentId === intentId)
    if (snapshot === undefined) return // the intent already closed / the handler dropped it
    lastSnapshotWriteMs.set(intentId, now)
    void repo.upsertTrackerSnapshot({ intentId, snapshot, updatedTs: now })
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
      configHash: deps.configHash,
    })
    const rec = intents.get(intentId)
    if (rec) rec.state = to
  }

  function onFundingPredicted(event: FundingPredicted): void {
    predicted.set(event.symbol, event)
  }

  /**
   * Record the `T_drop − T_settle` offset (`00_globals` §8.3) on every live intent on the symbol
   * when the venue's `FundingFeeAccrued` (which marks `T_drop`) arrives. Written at source because
   * the `pnl` row is write-once (0410 cannot backfill a null); an intent with no `settleTs` (no
   * gate) is left null — spec-legal. Accounting only (0390).
   */
  function recordFundingDrop(event: FundingFeeAccrued): void {
    for (const rec of intents.values()) {
      if (rec.symbol !== event.symbol || rec.settleTs === undefined) continue
      if (TERMINAL_INTENT_STATES.includes(rec.state)) continue
      rec.tDropOffsetS = Math.round((event.fundingTime - rec.settleTs) / 1000)
    }
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
      breakerOpen: breakerOpen(), // venue-io circuit breaker (0380); defaults false.
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

  /**
   * Pre-entry stale reduce-only sweep (`13`, 0380): cancel any resting reduce-only order for
   * `symbol` the engine no longer tracks — a leftover from a crashed prior intent that would
   * otherwise fight a fresh entry. Fire-and-forget (mirrors `onEntry`'s sync `placeOrder`) and
   * fail-open: a `getOpenOrders` throw is swallowed, since a reduce-only order can never open a
   * wrong-direction position. Only untracked orders are swept — a live exit leg stays in
   * `pendingOrders`, so a concurrent intent's resting reduce-only leg is never cancelled.
   */
  function sweepStaleReduceOnly(symbol: string): void {
    void exchange
      .getOpenOrders(symbol)
      .then((orders) => {
        for (const o of orders) {
          if (o.reduceOnly !== true || pendingOrders.has(o.clientOrderId)) continue
          void exchange.cancelOrder(o.clientOrderId).catch(() => {})
        }
      })
      .catch(() => {})
  }

  function onEntry(event: Timer): void {
    const symbol = event.symbol
    if (symbol === undefined) return
    // Clear any stale reduce-only leftover before this symbol's entry places (`13`, 0380).
    sweepStaleReduceOnly(symbol)
    // S6 (`07` §2) delegates the whole entry to its sub-machine (PRE_FUNDING → funding-gate → MAIN
    // reversal). Presence of the marker is the switch — every non-S6 strategy is unaffected.
    if (entrySubMachine !== undefined) {
      onEntrySubMachine(event, symbol)
      return
    }
    // Ladder strategies (S4.1a) pre-place N rung limits + an engine-side SL instead of one
    // market order (`05` §2). Presence of the plan is the switch — every non-ladder strategy
    // stays on the single-market path unchanged.
    if (activeModule.entryPlan !== undefined) {
      onEntryLadder(event, symbol, activeModule.entryPlan)
      return
    }

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

  /**
   * Ladder entry path (S4.1a, `05` §2): pre-place N BUY-LIMIT rungs below `P_ref`, arm the
   * engine-side conditional SL anchored to the precomputed `P_avg_full`, and engine-schedule the
   * deadline (owned by the engine, not the handler, so a zero-fill ladder can terminate before the
   * handler ever arms). Fail-closed on an unknown price; skip the symbol entirely when the top rung
   * is infeasible (§G-R feasibility gate — no intent row, no trace).
   */
  function onEntryLadder(event: Timer, symbol: string, plan: LadderEntryPlan): void {
    const intentId = `${symbol}-${event.ts}`
    const refPrice = latestPrice.get(symbol)
    if (refPrice === undefined) return // fail-closed, as the market path does

    const instrument = exchange.normalize(symbol)
    const ratePercent = rateBySymbol.get(symbol)
    const snapped = plan.rungPrices(refPrice, strategyConfig, ratePercent).map((p) => roundPrice(p, instrument))
    const rungSplit = splitLadder(strategyConfig.amountUsd, snapped, instrument)
    if (rungSplit.length === 0) return // top rung infeasible → skip symbol entirely (§G-R), no trace

    const totalQty = rungSplit.reduce((sum, r) => sum + r.qty, 0)
    // Preflight on the total qty before creating the intent row: `skip` leaves no trace.
    const result = runPreflight(preflightSnapshot(symbol, totalQty), riskGate, symbol)
    if (result.kind === 'skip') return

    const settleTs = settleBySymbol.get(symbol)
    const rec: IntentRecord = {
      symbol,
      state: 'SELECTED',
      entrySide,
      entryQty: totalQty,
      settleTs,
      anchorPrice: refPrice,
      ratePercent,
      filledQty: 0,
      filledNotional: 0,
    }
    const stashedCost = costBySymbol.get(symbol)
    if (stashedCost !== undefined) rec.costBreakdown = stashedCost
    intents.set(intentId, rec)

    if (result.kind === 'reject') {
      commit({ intentId, symbol, from: 'SELECTED', to: 'ABORTED', payload: { errorCode: result.errorCode } })
      return
    }

    // P_avg_full over the placed rungs (`05` §2 step 1): the engine-side SL anchor, known in advance.
    const pAvgFull = rungSplit.reduce((sum, r) => sum + r.price * r.qty, 0) / totalQty
    rec.pAvgFull = pAvgFull
    if (settleTs === undefined || strategyConfig.deadlineSeconds === undefined) {
      throw new Error(`Engine: ladder intent '${intentId}' missing settleTs/deadlineSeconds for the deadline`)
    }
    const deadlineMs = settleTs + strategyConfig.deadlineSeconds * 1000
    rec.deadlineMs = deadlineMs

    const rungs: LadderRung[] = rungSplit.map((r, i) => ({
      coid: makeClientOrderId({ intentId, leg: 'entry', attempt: i + 1 }),
      price: r.price,
      qty: r.qty,
      filled: false,
    }))
    rec.ladderRungs = rungs
    const firstCoid = rungs[0]?.coid

    commit({
      intentId,
      symbol,
      from: 'SELECTED',
      to: 'SUBMITTING_ENTRY',
      payload: {},
      extras: { clientOrderId: firstCoid, entrySide, entryQty: totalQty, tSettleMs: settleTs },
    })
    // S4.2a (`06` §2 R5): a module with a no-fill terminal code carries `expireAt` on each entry
    // limit, so the venue expires it at the deadline → `NO_POSITION{limit_expired}`. Absent ⇒ no
    // `expireAt` (S4.1a byte-unchanged), and the deadline terminal stays engine-timer driven.
    const entryExpireAt = activeModule.entryExpiryErrorCode !== undefined ? deadlineMs : undefined
    for (const rung of rungs) {
      pendingOrders.set(rung.coid, { intentId, leg: 'entry' })
      void exchange.placeOrder({
        symbol,
        side: entrySide,
        type: 'limit',
        qty: rung.qty,
        price: rung.price,
        clientOrderId: rung.coid,
        expireAt: entryExpireAt,
      })
    }
    // Arm the SL at placement time (before any fill — `05` §2 step 1), and engine-schedule the deadline.
    conditionalStops.set(intentId, {
      intentId,
      triggerPrice: plan.slTriggerPrice(pAvgFull, strategyConfig, ratePercent),
      side: entrySide,
    })
    scheduler.scheduleDeadlineTimer(intentId, deadlineMs)
  }

  /**
   * S6 entry path (`07` §2): size the MAIN leg (`mainAmountUsd`) and the tiny PRE_FUNDING leg (min
   * feasible qty), apply the reversal sizing guard (`preQty < mainQty`, else the reversal leaves no
   * net position → skip with no trace), preflight the **net** qty, commit `SELECTED → SUBMITTING_ENTRY`,
   * and hand the choreography to the sub-machine. Fail-closed on an unknown price, as the market path does.
   */
  function onEntrySubMachine(event: Timer, symbol: string): void {
    if (entrySubMachine === undefined) return
    const intentId = `${symbol}-${event.ts}`
    const price = latestPrice.get(symbol)
    if (price === undefined) return // fail-closed
    const instrument = exchange.normalize(symbol)
    const mainQty = computeQty(strategyConfig.amountUsd, price, instrument)
    const preQty = minFeasibleQty(price, instrument)
    // Sizing guard (`07` §1), re-checked at submission against the fresh price: a reversal whose PRE leg
    // is not strictly smaller than the MAIN leg leaves no net position — skip, no intent row, no trace.
    if (preQty >= mainQty) return
    const netQty = mainQty - preQty

    // Preflight the managed net qty before creating the intent row: `skip` leaves no trace.
    const result = runPreflight(preflightSnapshot(symbol, netQty), riskGate, symbol)
    if (result.kind === 'skip') return

    const settleTs = settleBySymbol.get(symbol)
    const rec: IntentRecord = {
      symbol,
      state: 'SELECTED',
      entrySide, // = mainSide (the managed net direction); exitSide is the reduce-only close side.
      entryQty: netQty,
      settleTs,
      ratePercent: rateBySymbol.get(symbol),
    }
    const stashedCost = costBySymbol.get(symbol)
    if (stashedCost !== undefined) rec.costBreakdown = stashedCost
    intents.set(intentId, rec)

    if (result.kind === 'reject') {
      commit({ intentId, symbol, from: 'SELECTED', to: 'ABORTED', payload: { errorCode: result.errorCode } })
      return
    }
    if (settleTs === undefined) {
      throw new Error(`Engine: S6 intent '${intentId}' missing settleTs for the funding gate`)
    }
    if (strategyConfig.fundingFeeTimeoutSeconds === undefined) {
      throw new Error(`Engine: S6 intent '${intentId}' config has no fundingFeeTimeoutSeconds for the gate`)
    }
    commit({
      intentId,
      symbol,
      from: 'SELECTED',
      to: 'SUBMITTING_ENTRY',
      payload: {},
      extras: { entrySide, entryQty: netQty, tSettleMs: settleTs },
    })
    entrySubMachine.begin(
      {
        intentId,
        symbol,
        settleTs,
        timeoutSeconds: strategyConfig.fundingFeeTimeoutSeconds,
        preQty,
        mainQty,
        abortCloseSide: entrySide,
      },
      entryCtx,
    )
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
      settledRatePercent: rec.settledRatePercent,
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
    // Disarm any engine-side stop the moment we exit, so a raced later tick can't re-fire it.
    conditionalStops.delete(intentId)
    // `exitReason` rides on `EXITING` too (not just the terminal `CLOSED` payload) so a crash
    // between the exit-leg WAL append and its fill still recovers *why* the leg was placed
    // (`14` §5 full matrix, 0370) — otherwise a recovered `EXITING` intent has no legal
    // `exitReason` to close with (R12).
    commit({
      intentId,
      symbol: rec.symbol,
      from: 'MONITORING',
      to: 'EXITING',
      payload: {},
      extras: { clientOrderId, exitReason },
    })
    pendingOrders.set(clientOrderId, { intentId, leg: 'exit' })
    void exchange.placeOrder({
      symbol: rec.symbol,
      side: exitSide,
      type: 'market',
      // Reduce-only the *filled* qty — for a ladder that is the aggregate of filled rungs, not the
      // full planned `entryQty` (`05` §2). Non-ladder strategies set `entryFillQty` on fill, so this
      // is a no-op change for them.
      qty: rec.entryFillQty ?? rec.entryQty,
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

  /** Record `→ CLOSED`, sweep any sibling reduce-only legs, reconcile, and book the trade — the shared exit tail. */
  function closeFromExiting(intentId: string, rec: IntentRecord, exitReason: ExitReason): void {
    conditionalStops.delete(intentId) // disarm the engine-side SL (idempotent with fireExit)
    commit({ intentId, symbol: rec.symbol, from: 'EXITING', to: 'CLOSED', payload: { exitReason } })
    // Post-exit reduce-only sweep (`00_globals.md` §5.2, `01` §2 step 5): cancel the sibling
    // legs still tracked open for this symbol (S2's SL/TP OCO); no-op on S1's market-exit path.
    sweepReduceOnlyOrders(intentId, rec.symbol)
    fireTradeClose(intentId, rec, { pExit: exitFillPxByIntent.get(intentId) })
    exitFillPxByIntent.delete(intentId)
    void finishReconciliation(intentId)
  }

  /**
   * Emit the terminal accounting projection to {@link EngineDeps.onTradeClose} (`15` §1, 0390).
   * Fired at every managed-lifecycle terminal (`CLOSED` / `NO_POSITION`); `pExit` rides on `CLOSED`,
   * `errorCode` on `NO_POSITION`. Absent-hook ⇒ no-op (existing callers untouched).
   */
  function fireTradeClose(
    intentId: string,
    rec: IntentRecord,
    outcome: { readonly pExit?: number; readonly errorCode?: ErrorCode },
  ): void {
    if (deps.onTradeClose === undefined) return
    const isLadder = rec.ladderRungs !== undefined
    const fillCount = isLadder
      ? (rec.ladderRungs?.filter((r) => r.filled).length ?? 0)
      : rec.entryFillQty !== undefined
        ? 1
        : 0
    deps.onTradeClose({
      intentId,
      symbol: rec.symbol,
      strategyId: strategyConfig.id,
      entrySide: rec.entrySide,
      exitReason: rec.exitReason,
      errorCode: outcome.errorCode,
      // A ladder books its fill-weighted `P_avg`; a single entry books `P_entry`.
      pEntry: isLadder ? undefined : rec.entryFillPx,
      pExit: outcome.pExit,
      pAvg: isLadder ? rec.entryFillPx : undefined,
      entryQty: rec.entryQty,
      filledQty: rec.entryFillQty,
      fillCount,
      fundingReceived: rec.fundingReceived ?? false,
      enteredAtMs: rec.enteredAtMs,
      closedAtMs: clock.now(),
      tSettleMs: rec.settleTs,
      tDropOffsetS: rec.tDropOffsetS,
    })
  }

  /**
   * Evaluate the engine-side conditional stops for `symbol` against `price` (`05` §2 step 1). A
   * triggered stop with filled qty market-closes the *filled* qty (`sl_hit`); a degenerate trigger
   * with nothing filled (pre-fill gap-through) cancels the rungs → `NO_POSITION{ladder_no_fills}`.
   */
  function evaluateConditionalStops(symbol: string, price: number): void {
    for (const [intentId, stop] of [...conditionalStops]) {
      const rec = intents.get(intentId)
      if (rec === undefined || rec.symbol !== symbol) continue
      if (!isTriggered(stop, price)) continue
      conditionalStops.delete(intentId)
      if ((rec.filledQty ?? 0) > 0 && rec.state === 'MONITORING') {
        fireExit(intentId, rec, 'sl_hit')
      } else if (rec.state === 'SUBMITTING_ENTRY') {
        terminateLadderNoFills(intentId, rec)
      }
    }
  }

  /** Route one MONITORING event through the active exit-policy handler; fire the exit on a decision (`12` §5). */
  function dispatchToExitPolicy(event: MonitoredEvent): void {
    for (const [intentId, rec] of exitTargets(event)) {
      if (rec.state !== 'MONITORING') continue
      const decision = exitHandler.onEvent(event, toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
      if (decision !== undefined) fireExit(intentId, rec, decision.exitReason)
      else maybeWriteTrackerSnapshot(intentId) // throttled — mirrors the S2 TP re-place cadence
    }
  }

  function onTimer(event: Timer): void {
    if (event.kind === 'scan') onScan(event)
    else if (event.kind === 'entry') onEntry(event)
    else onDeadline(event)
  }

  /**
   * A `deadline` Timer. A zero-fill ladder still in `SUBMITTING_ENTRY` terminates here
   * (`05` §2 step 6) — `dispatchToExitPolicy` would drop it since it targets only MONITORING.
   * A MONITORING intent (ladder or not) routes to the exit policy as before.
   */
  function onDeadline(event: Timer): void {
    const intentId = event.intentId
    if (intentId !== undefined) {
      const rec = intents.get(intentId)
      if (rec?.state === 'SUBMITTING_ENTRY' && rec.ladderRungs !== undefined) {
        terminateLadderNoFills(intentId, rec)
        return
      }
    }
    dispatchToExitPolicy(event)
  }

  /** Cancel all unfilled rungs and terminate a zero-fill ladder `NO_POSITION{ladder_no_fills}` (`05` §2 step 6). */
  function terminateLadderNoFills(intentId: string, rec: IntentRecord): void {
    conditionalStops.delete(intentId)
    sweepReduceOnlyOrders(intentId, rec.symbol) // cancels the unfilled entry rungs (no exit legs exist yet)
    // S4.2a's no-fill terminal is `limit_expired` (`06` §2 R5); every other ladder is `ladder_no_fills`.
    const errorCode = activeModule.entryExpiryErrorCode ?? 'ladder_no_fills'
    commit({ intentId, symbol: rec.symbol, from: 'SUBMITTING_ENTRY', to: 'NO_POSITION', payload: { errorCode } })
    fireTradeClose(intentId, rec, { errorCode })
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
        // S6 threads the settled `|F|` onto the intent so recovery re-derives the OCO geometry; absent for
        // every other strategy (JSON drops `undefined`), so their goldens are byte-unchanged.
        settledRatePercent: rec.settledRatePercent,
      },
    })
    // Force-write so a durable snapshot exists the instant the resting legs do — a crash
    // right after this commit must not recover into the "no snapshot" fallback (`14` §7).
    maybeWriteTrackerSnapshot(intentId, true)
  }

  function onEntryOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    // S6 (`07` §2): the PRE/MAIN updates route to the sub-machine, which owns the entry FSM. This
    // bypasses the hard-coded `main_order_*` mapping below (unchanged for every non-S6 strategy).
    if (entrySubMachine !== undefined) {
      entrySubMachine.onOrderUpdate(event, intentId, entryCtx)
      return
    }
    if (rec.ladderRungs !== undefined) {
      onLadderRungUpdate(event, intentId, rec)
      return
    }
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

  /**
   * One ladder rung update (S4.1a, `05` §2 step 2/3). A rung FILLED aggregates into the running
   * `P_avg`; the first fill advances `SUBMITTING_ENTRY → MONITORING`, each fill (re-)places the TP.
   * A rung filling while the intent is already exiting is the cancel/fill race — closed by a
   * protective reduce-only market (`05` §2 step 4). Non-fill terminals (reject/cancel/expire) just
   * drop the rung from tracking; a single dead rung never fails the whole ladder.
   */
  function onLadderRungUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    const rung = rec.ladderRungs?.find((r) => r.coid === event.clientOrderId)
    if (event.status === 'FILLED') {
      pendingOrders.delete(event.clientOrderId)
      if (rung !== undefined) rung.filled = true
      if (rec.state === 'EXITING' || rec.state === 'CLOSED') {
        // Cancel/fill race: the exit is in flight but this rung crossed — protectively close its qty.
        protectiveClose(intentId, rec, event.qty ?? 0, rung)
        return
      }
      aggregateRungFill(intentId, rec, event.fillPx, event.qty ?? 0)
      return
    }
    if (
      event.status === 'REJECTED' ||
      event.status === 'FAILED' ||
      event.status === 'CANCELLED' ||
      event.status === 'EXPIRED'
    ) {
      pendingOrders.delete(event.clientOrderId)
      // S4.2a (`06` §2 R5): the venue-side `expireAt` fired. A zero-fill entry with no live rung left
      // is the `limit_expired` no-fill terminal; for the single rung this fires on its own `EXPIRED`.
      if (event.status === 'EXPIRED') maybeTerminateOnEntryExpiry(intentId, rec)
    }
  }

  /**
   * A ladder rung expired unfilled (`06` §2 R5, S4.2a). If the module carries a no-fill terminal
   * code, the intent is still pre-fill in `SUBMITTING_ENTRY`, and no rung remains live, terminate
   * `NO_POSITION{entryExpiryErrorCode}`. The deadline timer at the same instant then no-ops (the
   * intent has left `SUBMITTING_ENTRY`) — idempotent and tie-order safe.
   */
  function maybeTerminateOnEntryExpiry(intentId: string, rec: IntentRecord): void {
    if (activeModule.entryExpiryErrorCode === undefined) return
    if (rec.state !== 'SUBMITTING_ENTRY' || (rec.filledQty ?? 0) > 0) return
    const liveRung = rec.ladderRungs?.some((r) => pendingOrders.has(r.coid)) ?? false
    if (!liveRung) terminateLadderNoFills(intentId, rec)
  }

  /** Fold a rung fill into the running fill-weighted `P_avg`, advance to MONITORING on the first fill, re-place the TP. */
  function aggregateRungFill(intentId: string, rec: IntentRecord, fillPx: number | undefined, fillQty: number): void {
    if (fillPx === undefined || fillQty <= 0) return
    rec.filledNotional = (rec.filledNotional ?? 0) + fillPx * fillQty
    rec.filledQty = (rec.filledQty ?? 0) + fillQty
    const pAvg = rec.filledNotional / rec.filledQty

    if (rec.state === 'SUBMITTING_ENTRY') {
      // First fill: a pre-settlement rung fill is kept but flagged (`05` §2 step 2); then → MONITORING
      // with the aggregate (ladder `arm` places nothing, returns the engine-scheduled deadline).
      const enteredAtMs = clock.now()
      if (rec.settleTs !== undefined && enteredAtMs < rec.settleTs) {
        deps.onOpsEvent?.({ kind: 'ladder.pre_funding_fill', intentId, symbol: rec.symbol })
      }
      adoptEntryFill(intentId, rec, pAvg, rec.filledQty)
    } else if (rec.state === 'MONITORING') {
      // Subsequent (lower) fill: recompute the aggregate; the TP re-place resizes/reprices the exit.
      rec.entryFillPx = pAvg
      rec.entryFillQty = rec.filledQty
    }
    if (rec.state === 'MONITORING') {
      exitHandler.onEntryFill?.(toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
    }
  }

  /** Protective reduce-only market close of a rung that filled during exit (`05` §2 step 4). Fire-and-forget. */
  function protectiveClose(intentId: string, rec: IntentRecord, qty: number, rung: LadderRung | undefined): void {
    if (qty <= 0) return
    const attempt = rung ? (rec.ladderRungs?.indexOf(rung) ?? 0) + 1 : 1
    const clientOrderId = makeClientOrderId({ intentId, leg: 'protect', attempt })
    void exchange.placeOrder({
      symbol: rec.symbol,
      side: exitSide,
      type: 'market',
      qty,
      clientOrderId,
      reduceOnly: true,
    })
  }

  function onExitOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    if (event.status !== 'FILLED') return
    pendingOrders.delete(event.clientOrderId)
    if (event.fillPx !== undefined) exitFillPxByIntent.set(intentId, event.fillPx) // pExit for accounting (0390)
    // The exit reason was stashed by the exit-policy handler on `→ EXITING`; a fill
    // with none recorded is a broken invariant, not a default (fail loud).
    const exitReason = rec.exitReason
    if (exitReason === undefined) throw new Error(`Engine: exit fill for '${intentId}' has no recorded exit reason`)
    closeFromExiting(intentId, rec, exitReason)
  }

  /** Route an update on a handler-owned resting leg (S2's SL/TP) to the exit policy; a fill drives the OCO close. */
  function onExitPolicyOrderUpdate(event: OrderUpdate, intentId: string, rec: IntentRecord): void {
    if (rec.state !== 'MONITORING') return
    // Stash the OCO leg's fill price before the handler drives the close (`confirmClose` carries no
    // px) so the terminal `onTradeClose` books `pExit` (accounting, 0390).
    if (event.status === 'FILLED' && event.fillPx !== undefined) exitFillPxByIntent.set(intentId, event.fillPx)
    exitHandler.onOrderUpdate?.(event, toMonitoredIntent(intentId, rec), strategyConfig, exitCtx)
  }

  /**
   * Cancel reduce-only (exit-leg) orders the engine still tracks open for `symbol`.
   * Engine-tracked only: a venue-side sweep needs a `getOpenOrders` port the adapter
   * interface lacks (logged as a SUGGESTION); full stale-sweep-before-entry is 0380.
   */
  function sweepReduceOnlyOrders(intentId: string, symbol: string): void {
    for (const [clientOrderId, pending] of [...pendingOrders]) {
      const isExitLeg = pending.leg === 'exit' || pending.leg === 'exit-policy'
      // Ladder exit also cancels this intent's still-unfilled entry rungs (`05` §2 step 4): they
      // rest open until exit, then are cancelled — never earlier. Only the closing intent's rungs.
      const isLadderEntry = pending.leg === 'entry' && pending.intentId === intentId
      if (!isExitLeg && !isLadderEntry) continue
      if (intents.get(pending.intentId)?.symbol !== symbol) continue
      pendingOrders.delete(clientOrderId)
      // Best-effort: a since-filled/unknown order throws — swallow it, the intent is CLOSED.
      void exchange.cancelOrder(clientOrderId).catch(() => {})
    }
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
        // Engine-side SL first (`05` §2/§3): a triggered ladder stop fires before the tick reaches
        // the exit policy, so a MONITORING intent exits on this tick rather than resting a TP off it.
        evaluateConditionalStops(event.symbol, event.price)
        dispatchToExitPolicy(event)
        return
      case 'BalanceUpdate':
        latestBalance = { asset: event.asset, free: event.free, used: event.used }
        return
      // The funding-fee accrual is a MONITORING event — route it through the exit policy.
      case 'FundingFeeAccrued':
        recordFundingDrop(event)
        dispatchToExitPolicy(event)
        // For S6 it is also an *entry* trigger: the gate that fires MAIN opens on this event while the
        // intent is still `SUBMITTING_ENTRY` (`07` §2 step 3). The gate matches per-symbol + is idempotent.
        entrySubMachine?.onFundingFee(event, entryCtx)
        return
      // Stash the settled funding rate so S6's `enterMonitoring` can anchor its OCO geometry on the
      // SETTLED `|F|` at MAIN fill (`07` §2 step 4), distinct from the decision-time predicted rate.
      case 'FundingSettled':
        settledRateBySymbol.set(event.symbol, event.rate)
        return
      // Not consumed by the skeleton yet — explicit no-ops keep the switch exhaustive.
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

  /**
   * A recovered `SELECTED` intent: no order has ever been placed, so nothing WALs it there —
   * `onEntry`/`onEntryLadder`/`onEntrySubMachine` run `intents.set` synchronously through to
   * the first `commit()` (`SELECTED → SUBMITTING_ENTRY`/`ABORTED`) with no `await` between,
   * so this state never actually reaches the WAL/repo in the live engine (`14` §5 full
   * matrix, 0370 — proven by the crash matrix finding no WAL row for this point). Defensive
   * only: if a future producer ever WALs a bare `SELECTED`, there is no safe re-decision post
   * crash (the entry window may already have passed) — leave it inert; the next scan
   * re-evaluates the symbol fresh.
   */
  async function recoverSelected(r: RecoveredIntent): Promise<void> {
    intents.set(r.intentId, {
      symbol: r.symbol,
      state: 'SELECTED',
      entrySide: r.entrySide ?? entrySide,
      entryQty: r.entryQty ?? 0,
      settleTs: r.tSettleMs,
    })
    return Promise.resolve()
  }

  async function recoverMonitoring(r: RecoveredIntent, snapshot: TrackerSnapshotRecord | undefined): Promise<void> {
    const rec: IntentRecord = {
      symbol: r.symbol,
      state: 'MONITORING',
      entrySide: r.entrySide ?? entrySide,
      entryQty: r.entryQty ?? 0,
      entryFillPx: r.entryFillPx,
      settleTs: r.tSettleMs,
      fundingReceived: r.fundingReceived,
      settledRatePercent: r.settledRatePercent,
      deadlineMs: r.tDeadlineMs,
    }
    intents.set(r.intentId, rec)
    // Reconcile qty against venue ground truth — do NOT replace the live order.
    const positions = await exchange.getPositions()
    rec.entryFillQty = positions.find((p) => p.symbol === r.symbol)?.qty ?? r.entryQty

    // Deep-restored handler (S2, decision #2): its per-intent tracker/legs were already
    // rehydrated by the one `handler.restore()` call in `recover()` below — re-arming would
    // replace the resting legs under a reset attempt counter and desync the rotating TP
    // (`03` §3). Only the engine-owned deadline timer needs re-scheduling here.
    if (snapshot !== undefined && isSnapshotCapable(exitHandler)) {
      if (r.tDeadlineMs !== undefined) scheduler.scheduleDeadlineTimer(r.intentId, r.tDeadlineMs)
      return
    }
    // Missing-snapshot fallback (decision #2): a snapshot-capable handler with nothing
    // persisted yet (crash before the first forward, or PG behind) restarts its tracker from
    // the current price — conservative, the position stays guarded by whatever resting SL/TP
    // survive on the venue. `anchorPrice` never rides the WAL (no goldens churn), so it is
    // synthesized here: latest observed tick, falling back to the recovered entry fill.
    rec.anchorPrice = latestPrice.get(r.symbol) ?? r.entryFillPx
    // Blind re-arm: every other handler (`timed`, `funding_fee_event`, the static
    // `sl_tp_deadline` OCO) recomputes its resting legs at DETERMINISTIC `(leg, attempt)`
    // client order ids — idempotent by construction, the same guarantee `recoverSubmitting`
    // relies on (`11` §4). The ladder `sl_tp_deadline` variant's `arm()` is a no-op (its TP
    // lives on `onEntryFill`, never called here — the existing resting TP survives on the
    // venue untouched) and does not itself schedule the deadline, so the engine always also
    // schedules it directly; a handler that also schedules it produces a harmless duplicate
    // `deadline` Timer — `dispatchToExitPolicy` guards on `state === 'MONITORING'`, so the
    // second delivery (after the first already fired the exit) no-ops.
    if (r.tDeadlineMs !== undefined) {
      exitHandler.arm(toMonitoredIntent(r.intentId, rec), strategyConfig, exitCtx)
      scheduler.scheduleDeadlineTimer(r.intentId, r.tDeadlineMs)
    }
  }

  /**
   * A recovered `EXITING` intent: the reduce-only exit leg was placed but its fill (or the
   * `→ CLOSED` WAL append) never landed. `r.exitReason` rides the `EXITING` transition
   * (`fireExit`) precisely so this has a legal value to close with (R12) — absent only for a
   * pre-0370 WAL, where `deadline` is the fail-safe default (every deadline-driven exit is a
   * `requestExit('deadline')`/`confirmClose` call, so it is the least-wrong guess).
   */
  async function recoverExiting(r: RecoveredIntent): Promise<void> {
    const exitReason: ExitReason = r.exitReason ?? 'deadline'
    const rec: IntentRecord = {
      symbol: r.symbol,
      state: 'EXITING',
      entrySide: r.entrySide ?? entrySide,
      entryQty: r.entryQty ?? 0,
      entryFillPx: r.entryFillPx,
      settleTs: r.tSettleMs,
      fundingReceived: r.fundingReceived,
      exitReason,
    }
    intents.set(r.intentId, rec)
    const clientOrderId = r.clientOrderId ?? makeClientOrderId({ intentId: r.intentId, leg: 'exit', attempt: 1 })

    let order: Order | undefined
    try {
      order = await exchange.getOrder(clientOrderId)
    } catch {
      order = undefined // WAL has the order but the venue never saw it (`14` §5 step 4) — re-issue.
    }
    if (order?.status === 'FILLED') {
      closeFromExiting(r.intentId, rec, exitReason) // already on venue — adopt, no re-submit.
      return
    }
    // Re-issue with the SAME clientOrderId — idempotent by construction, no duplicate. Size
    // off venue ground truth (not the WAL's `entryQty`, which the EXITING transition never
    // carries): whatever qty is still open is exactly what the reduce-only leg must close.
    const positions = await exchange.getPositions()
    const qty = positions.find((p) => p.symbol === r.symbol)?.qty ?? rec.entryQty
    pendingOrders.set(clientOrderId, { intentId: r.intentId, leg: 'exit' })
    void exchange.placeOrder({ symbol: r.symbol, side: exitSide, type: 'market', qty, clientOrderId, reduceOnly: true })
  }

  const unsubscribe: Unsubscribe = bus.subscribe(dispatch)
  // Kill-switch `flatten` (`13` §3, 0380): terminalize every MONITORING intent through the
  // existing reduce-only exit path (`fireExit`) so each row reaches CLOSED(kill_switch_flatten).
  // Only wired when the dep carries `subscribe` (the real KillSwitch); the default source omits it.
  const killSwitchUnsub: Unsubscribe | undefined = killSwitch.subscribe?.((state) => {
    if (state !== 'flatten') return
    for (const [intentId, rec] of [...intents]) {
      if (rec.state === 'MONITORING') fireExit(intentId, rec, 'kill_switch_flatten')
    }
  })

  return {
    async recover(
      recovered: readonly RecoveredIntent[],
      snapshots: readonly TrackerSnapshotRecord[] = [],
    ): Promise<void> {
      // Deep-restore the snapshot-capable handler's live per-intent state ONCE, up front, for
      // every persisted snapshot — `recoverMonitoring` below only (re-)schedules the deadline
      // for the intents it actually reaches.
      if (snapshots.length > 0 && isSnapshotCapable(exitHandler)) {
        exitHandler.restore(snapshots.map((s) => s.snapshot))
      }
      const snapshotByIntent = new Map(snapshots.map((s) => [s.intentId, s]))
      for (const r of recovered) {
        if (r.state === 'SELECTED') await recoverSelected(r)
        else if (r.state === 'SUBMITTING_ENTRY') await recoverSubmitting(r)
        else if (r.state === 'MONITORING') await recoverMonitoring(r, snapshotByIntent.get(r.intentId))
        else if (r.state === 'EXITING') await recoverExiting(r)
      }
    },
    intentState(intentId: string): IntentState | undefined {
      return intents.get(intentId)?.state
    },
    liveIntentCount(): number {
      return countLiveIntents()
    },
    costBreakdown(intentId: string): ProfitBreakdown | undefined {
      return intents.get(intentId)?.costBreakdown
    },
    fundingReceived(intentId: string): boolean | undefined {
      return intents.get(intentId)?.fundingReceived
    },
    dispose(): void {
      exitHandler.dispose?.() // release handler-owned resources (the funding gate's timers, S1-WS)
      entrySubMachine?.dispose() // release the S6 entry sub-machine's funding gate timers
      killSwitchUnsub?.() // stop listening for the kill-switch `flatten` (0380)
      unsubscribe()
    },
  }
}
