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
 * re-exports {@link ExitPolicyKind} from here. Only `timed` is wired in the skeleton
 * ({@link TIMED_PLACEHOLDER_HANDLER}); each strategy task (0280+) brings its own
 * handler for its kind — "add a handler", never "edit the engine".
 */

import type { FundingFeeAccrued, MarketTick, Timer } from '../events/types.js'
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
  /** Set on crash-recovery re-arm (deadline already known); absent on the live path. */
  readonly deadlineMs?: number
}

/** The port subset a handler uses to arm itself — scheduler + clock, nothing else. */
export interface ExitPolicyContext {
  /** Schedule the deadline timer for `intentId` at `atMs` (→ `scheduler.scheduleDeadlineTimer`). */
  scheduleDeadline(intentId: string, atMs: number): void
  /** Current instant, epoch ms (→ `clock.now`). */
  now(): number
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

/**
 * The refactored skeleton exit — the engine's old inline `timed` deadline, now a
 * handler. **Placeholder**: S1 (0280) replaces it with the real `timed` kind. It
 * arms a deadline at `enteredAtMs + holdMs` (or the recovered `deadlineMs`) and
 * fires `{ exitReason: 'timed' }` when that deadline Timer arrives.
 */
export const TIMED_PLACEHOLDER_HANDLER: ExitPolicyHandler = {
  kind: 'timed',
  arm(intent, config, ctx): number {
    const deadlineMs = intent.deadlineMs ?? intent.enteredAtMs + config.holdMs
    ctx.scheduleDeadline(intent.intentId, deadlineMs)
    return deadlineMs
  },
  onEvent(event, intent): ExitDecision | undefined {
    if (event.type === 'Timer' && event.kind === 'deadline' && event.intentId === intent.intentId) {
      return { exitReason: 'timed' }
    }
    return undefined
  },
}
