/**
 * Exit-policy dispatch (`12_strategy_runtime_and_intent_lifecycle.md` §5) — pure core.
 *
 * MONITORING behaviour is delegated to an **exit-policy handler selected by `kind`
 * via a registry**, not branched on strategy name inside the engine. Each strategy
 * module declares its `exitPolicyKind` (`registry.ts`); the engine resolves the one
 * handler for that kind at startup and routes every MONITORING event through it.
 * New exit policies register without touching the engine — the same Registry
 * pattern the strategy modules use (`08` §5).
 *
 * This file owns the exit-policy vocabulary (single source of truth): `registry.ts`
 * re-exports {@link ExitPolicyKind} from here. Only `timed` is wired so far (the real
 * `TIMED_HANDLER` in `exit-policies/timed.ts`, S1); each strategy task (0300+) brings
 * its own handler for its kind — "add a handler", never "edit the engine".
 */

import type { FundingFeeAccrued, MarketTick, OrderUpdate, Timer } from '../events/types.js'
import type { OrderType } from '../ports/exchange-adapter.js'
import type { RuntimeStrategyConfig } from '../strategies/registry.js'
import type { ExitReason } from './intent-machine.js'

/**
 * The five exit-policy families named in `12` §5 / `00_globals.md` Inventory. All
 * five are documented here so the vocabulary is complete; only `timed` is wired in
 * the skeleton — a strategy task adds its handler, it does not extend this union.
 */
export type ExitPolicyKind =
  | 'timed'
  | 'funding_fee_event'
  | 'sl_tp_deadline'
  | 'sl_tp_deadline_retracement_funding_event'
  | 'sl_tp_deadline_post_funding_event'

/** The events a handler observes while an intent is MONITORING (`12` §5). */
export type MonitoredEvent = MarketTick | FundingFeeAccrued | Timer

/** The read-only projection of a MONITORING intent a handler arms/reacts against. */
export interface MonitoredIntent {
  readonly intentId: string
  readonly symbol: string
  readonly entrySide: string
  readonly entryQty: number
  readonly entryFillPx?: number
  readonly enteredAtMs: number
  /** Settlement instant the intent entered against, epoch ms — the `timed` exit keys off this (`01` §3), not fill time. */
  readonly settleTs?: number
  /** Set on crash-recovery re-arm (deadline already known); absent on the live path. */
  readonly deadlineMs?: number
  /** Venue-confirmed entry fill qty (base units) — the reduce-only cap for handler-placed exit legs (S2). */
  readonly entryFillQty?: number
  /** Reference price at entry-decision time (`00_globals.md` §2 R8) — S2's retracement anchor (`03` §2). */
  readonly anchorPrice?: number
  /** Realized predicted funding rate the intent entered on, signed percent — S3a's TP `|F|` source (`04` §3). */
  readonly ratePercent?: number
}

/**
 * A handler-owned resting reduce-only leg (S2's SL stop / trailing TP limit). The
 * engine assigns the deterministic `clientOrderId` from `leg`+`attempt`, rounds the
 * price to the venue tick, and caps the qty to the entry fill — the handler owns only
 * the strategy semantics (`03` §2/§3).
 */
export interface ExitLegRequest {
  /** Hyphen-free leg code (`sl`/`tp`) for the deterministic client order id (`11` §4). */
  readonly leg: string
  /** Attempt counter — a rotating TP increments it per re-place. */
  readonly attempt: number
  readonly type: OrderType
  /** For `stop` this is the trigger (the port has no separate `stopPrice`); for `limit` the limit price. */
  readonly price?: number
  readonly qty: number
}

/** The port subset a handler uses to arm itself and fire out-of-band exits. */
export interface ExitPolicyContext {
  /** Schedule the deadline timer for `intentId` at `atMs` (→ `scheduler.scheduleDeadlineTimer`). */
  scheduleDeadline(intentId: string, atMs: number): void
  /** Current instant, epoch ms (→ `clock.now`). */
  now(): number
  /**
   * Fire the reduce-only exit for `intentId` **out of band** — the seam a gated policy
   * (`funding_fee_event`, S1-WS/S2/S6) needs, whose signals resolve on an async poll or a
   * gate-owned timer *outside* the engine's synchronous `onEvent` dispatch. The engine
   * guards on `state === 'MONITORING'`, so a duplicate/late call is idempotent (`02` §2).
   */
  requestExit(intentId: string, exitReason: ExitReason): void
  /**
   * Place a handler-owned resting reduce-only leg (S2's SL/TP) and return its assigned
   * `clientOrderId`. The engine builds the id, rounds `price`, caps `qty` to the entry
   * fill, registers the leg as `exit-policy` in `pendingOrders`, and submits it. The
   * intent stays `MONITORING` (no state transition — a resting leg is not an exit yet).
   */
  placeExitLeg(intentId: string, req: ExitLegRequest): string
  /** Cancel a handler-owned resting leg by its `clientOrderId` (best-effort; drops it from tracking). */
  cancelExitLeg(clientOrderId: string): void
  /**
   * Close an intent whose SL/TP already filled (position flat) — `MONITORING → EXITING →
   * CLOSED{exitReason}` in one step (the fill is already in hand), then sweep the sibling
   * leg and reconcile. Guarded on `state === 'MONITORING'`, so a raced/late call no-ops (`03` §2).
   */
  confirmClose(intentId: string, exitReason: ExitReason, filledClientOrderId: string): void
}

/** A handler's decision to fire the exit: the reason the engine records on `→ CLOSED`. */
export interface ExitDecision {
  readonly exitReason: ExitReason
}

/** One exit policy: its kind, how it arms on MONITORING entry, and how it reacts to events. */
export interface ExitPolicyHandler {
  readonly kind: ExitPolicyKind
  /**
   * Called on MONITORING entry: schedule timers/gates and return the deadline
   * instant the engine must persist for crash-recovery re-arm (`undefined` if the
   * kind has no deadline).
   */
  arm(intent: MonitoredIntent, config: RuntimeStrategyConfig, ctx: ExitPolicyContext): number | undefined
  /** React to one MONITORING event; return a decision to fire the exit, else `undefined`. */
  onEvent(
    event: MonitoredEvent,
    intent: MonitoredIntent,
    config: RuntimeStrategyConfig,
    ctx: ExitPolicyContext,
  ): ExitDecision | undefined
  /**
   * React to an update on a handler-owned resting leg (`pendingOrders.leg === 'exit-policy'`,
   * S2's SL/TP). A leg fill drives the OCO close via `ctx.confirmClose`. Absent ⇒ the kind
   * owns no resting legs (S1/S1-WS), so the engine never routes here.
   */
  onOrderUpdate?(
    event: OrderUpdate,
    intent: MonitoredIntent,
    config: RuntimeStrategyConfig,
    ctx: ExitPolicyContext,
  ): void
  /**
   * React to a ladder entry-rung fill (`05_strategy_4_1a.md` §2 step 3) — called by the
   * engine after **each** rung fill with `intent.entryFillPx` = current `P_avg` and
   * `intent.entryFillQty` = current filled qty. S4.1a re-places its TP (cancel prior,
   * place fresh at `P_avg × (1 + takeProfitPct/100)`, qty = filled qty). Absent ⇒ the
   * engine never calls it (non-ladder strategies unaffected).
   */
  onEntryFill?(intent: MonitoredIntent, config: RuntimeStrategyConfig, ctx: ExitPolicyContext): void
  /** Release any handler-owned resources (timers/gates) on engine shutdown. Absent ⇒ nothing to release. */
  dispose?(): void
}

export type ExitPolicyRegistry = ReadonlyMap<ExitPolicyKind, ExitPolicyHandler>

/** Build the registry from the handlers; a duplicate kind is a fail-loud startup error. */
export function createExitPolicyRegistry(handlers: readonly ExitPolicyHandler[]): ExitPolicyRegistry {
  const registry = new Map<ExitPolicyKind, ExitPolicyHandler>()
  for (const handler of handlers) {
    if (registry.has(handler.kind)) throw new Error(`ExitPolicyRegistry: duplicate exit-policy kind '${handler.kind}'`)
    registry.set(handler.kind, handler)
  }
  return registry
}
