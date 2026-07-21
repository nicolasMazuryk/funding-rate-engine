/**
 * The `sl_tp_deadline_retracement_funding_event` exit policy (`03_strategy_2.md` §2/§3)
 * — pure core. S2's exit: it refuses to realize the drop immediately and instead trails
 * the running low with a re-derived TP limit, bounded by a resting SL stop and a deadline,
 * with OCO (first fill cancels the siblings).
 *
 * Two parts:
 *  - a **pure reducer** {@link retracementReduce} `(state, event) → { state, commands }` — the
 *    trailing state machine, driven only by lows observed so far (causal, never a future
 *    low, `00_globals.md` §2 R8). Persistence is a snapshot of {@link TrackerState}, and the
 *    causality property is a prefix-replay equality on this function.
 *  - a **handler** {@link createRetracementHandler} that plugs it into the engine's exit-policy
 *    seam: on entry fill it places the SL, schedules the deadline, and arms one shared
 *    {@link FundingGate}; the gate's close (WS/REST open **or** timeout — the timeout is a
 *    tracker-arming fallback, not an exit) arms the tracker; each `MarketTick` rotates the TP;
 *    a `deadline` Timer fires the market close; an SL/TP fill drives the OCO close.
 *
 * The three concurrent reduce-only legs are placed/cancelled through the engine's
 * {@link ExitPolicyContext} order-command seam (`placeExitLeg`/`cancelExitLeg`/`confirmClose`
 * for the resting SL/TP; `requestExit` for the deadline market). Prices are emitted raw;
 * the engine rounds them at the edge (`roundPrice`).
 */

import type { Clock } from '../../ports/clock.js'
import type { FundingGate, FundingIncomePoll } from '../../runtime/funding-gate.js'
import { createFundingGate } from '../../runtime/funding-gate.js'
import type { ExitPolicyContext, ExitPolicyHandler } from '../exit-policy.js'
import type { ExitReason } from '../intent-machine.js'

/** ≤ 1 TP re-place per second (`03` §5 `replace_throttle_seconds`, engine constant). */
const REPLACE_THROTTLE_MS = 1000

/** Tracker phase: `sl_only` until the funding gate arms it, then `trailing` (`03` §2 steps 2–4). */
export type TrackerPhase = 'sl_only' | 'trailing'

/**
 * Per-intent trailing state — the whole persisted snapshot. `pLow` is the running min of
 * ticks seen since arming (never a future low, R8); `lastReplaceMs` doubles as the
 * "a TP has been placed" flag (set on every re-place, undefined before the first).
 */
export interface TrackerState {
  readonly phase: TrackerPhase
  /** Reference price at entry-decision time (`03` §2), the retracement target with `retracementPct = 1`. */
  readonly anchorPrice: number
  /** Fraction [0,1] of the `anchor − low` gap the TP sits above the low (`03` §5, the lone fraction key). */
  readonly retracementPct: number
  /** Lowest price observed since arming, epoch of ticks so far. Undefined until the first trailing tick. */
  readonly pLow?: number
  /** Clock instant of the last TP re-place, ms — the throttle anchor and the first-place flag. */
  readonly lastReplaceMs?: number
}

/** The events the reducer folds. `tick` carries the observing instant so the throttle is deterministic. */
export type RetracementEvent =
  | { readonly kind: 'gateOpen' }
  | { readonly kind: 'tick'; readonly px: number; readonly nowMs: number }
  | { readonly kind: 'fill'; readonly leg: 'sl' | 'tp' }
  | { readonly kind: 'deadline' }

/**
 * The commands the reducer emits. `placeTp`/`cancelTp` rotate the resting TP; `close` ends
 * the intent — `alreadyFlat` distinguishes an SL/TP fill (position already flat, siblings
 * swept) from a deadline market close (`alreadyFlat: false`).
 */
export type RetracementCommand =
  | { readonly kind: 'placeTp'; readonly price: number }
  | { readonly kind: 'cancelTp' }
  | { readonly kind: 'close'; readonly exitReason: ExitReason; readonly alreadyFlat: boolean }

export interface RetracementResult {
  readonly state: TrackerState
  readonly commands: readonly RetracementCommand[]
}

/** Fresh tracker for a newly-armed intent (phase `sl_only`, no low observed yet). */
export function createTrackerState(anchorPrice: number, retracementPct: number): TrackerState {
  return { phase: 'sl_only', anchorPrice, retracementPct }
}

/** The trailing TP price for a given low: `P_low + (anchor − P_low) × retracementPct` (`03` §3). */
export function retracementTarget(anchorPrice: number, pLow: number, retracementPct: number): number {
  return pLow + (anchorPrice - pLow) * retracementPct
}

/** Fold one tick: update the running low, and (throttle permitting) re-place the TP at the new target. */
function reduceTick(state: TrackerState, px: number, nowMs: number): RetracementResult {
  if (state.phase !== 'trailing') return { state, commands: [] } // SL-only window: ignore ticks
  const isNewLow = state.pLow === undefined || px < state.pLow
  if (!isNewLow) return { state, commands: [] }
  const loweredState: TrackerState = { ...state, pLow: px }
  // Running-min always advances on a new low; the re-place is throttled to ≤ 1/s.
  if (state.lastReplaceMs !== undefined && nowMs - state.lastReplaceMs < REPLACE_THROTTLE_MS) {
    return { state: loweredState, commands: [] }
  }
  const price = retracementTarget(state.anchorPrice, px, state.retracementPct)
  // `lastReplaceMs === undefined` ⇔ no TP resting yet ⇒ place-only; otherwise cancel-then-replace.
  const commands: RetracementCommand[] =
    state.lastReplaceMs === undefined
      ? [{ kind: 'placeTp', price }]
      : [{ kind: 'cancelTp' }, { kind: 'placeTp', price }]
  return { state: { ...loweredState, lastReplaceMs: nowMs }, commands }
}

/** The pure trailing reducer (`03` §2/§3). Same `(state, event)` → same `(state, commands)`, no I/O. */
export function retracementReduce(state: TrackerState, event: RetracementEvent): RetracementResult {
  switch (event.kind) {
    case 'gateOpen':
      // The gate closing (open OR timeout) arms the tracker; idempotent if already trailing.
      return state.phase === 'sl_only'
        ? { state: { ...state, phase: 'trailing' }, commands: [] }
        : { state, commands: [] }
    case 'tick':
      return reduceTick(state, event.px, event.nowMs)
    case 'fill':
      return {
        state,
        commands: [{ kind: 'close', exitReason: event.leg === 'sl' ? 'sl_hit' : 'tp_hit', alreadyFlat: true }],
      }
    case 'deadline':
      return { state, commands: [{ kind: 'close', exitReason: 'deadline', alreadyFlat: false }] }
  }
}

/** The ports the handler injects into its funding gate: the clock + the REST funding-income poll. */
export interface RetracementDeps {
  readonly clock: Clock
  readonly fundingIncome: FundingIncomePoll
}

/** Live per-intent handler state: the reducer snapshot plus the resting-leg client order ids it owns. */
interface TrackerRecord {
  tracker: TrackerState
  readonly symbol: string
  /** Reduce-only qty cap for placed legs (the venue-confirmed entry fill). */
  readonly entryQty: number
  slCoid?: string
  tpCoid?: string
  /** Incrementing attempt counter for the rotating TP's deterministic client order id. */
  tpAttempt: number
}

/** Serializable per-intent tracker state for the same-session restart test (0310; full recovery is 0370). */
export interface RetracementSnapshot {
  readonly intentId: string
  readonly tracker: TrackerState
  readonly symbol: string
  readonly entryQty: number
  readonly slCoid?: string
  readonly tpCoid?: string
  readonly tpAttempt: number
}

/** The handler plus its snapshot pair (extra members beyond {@link ExitPolicyHandler}; the engine uses only the base). */
export interface RetracementHandler extends ExitPolicyHandler {
  /** Snapshot every live tracker for a restart. */
  serialize(): RetracementSnapshot[]
  /** Rehydrate trackers from a snapshot (same-session restart). */
  restore(snapshots: readonly RetracementSnapshot[]): void
}

/**
 * Build the `sl_tp_deadline_retracement_funding_event` handler (S2), owning one shared
 * funding gate whose close arms the per-intent retracement tracker.
 */
export function createRetracementHandler(deps: RetracementDeps): RetracementHandler {
  const records = new Map<string, TrackerRecord>()

  const gate: FundingGate = createFundingGate({
    clock: deps.clock,
    poll: deps.fundingIncome,
    observer: (signal) => {
      // Any finalizing close arms the tracker — a `timeout` is a tracker-arming fallback,
      // NOT an exit (`03` §2 step 3), unlike S1-WS where it fires the exit.
      if (signal.type !== 'GateClosed') return
      const rec = records.get(signal.intentId)
      if (rec === undefined) return
      rec.tracker = retracementReduce(rec.tracker, { kind: 'gateOpen' }).state
    },
  })

  /** SL trigger: `P_entry × (1 − |F| × slMultiplier/100)` (`03` §3); `|F|` is the selection threshold. */
  function slTriggerPrice(entryFillPx: number, thresholdPercent: number, slMultiplier: number): number {
    return entryFillPx * (1 - (Math.abs(thresholdPercent) * slMultiplier) / 100)
  }

  /** Execute the reducer's TP rotate commands against the engine's order-command seam. */
  function applyTrailingCommands(
    intentId: string,
    rec: TrackerRecord,
    commands: readonly RetracementCommand[],
    ctx: ExitPolicyContext,
  ): void {
    for (const cmd of commands) {
      if (cmd.kind === 'cancelTp') {
        if (rec.tpCoid !== undefined) {
          ctx.cancelExitLeg(rec.tpCoid)
          rec.tpCoid = undefined
        }
      } else if (cmd.kind === 'placeTp') {
        rec.tpAttempt += 1
        rec.tpCoid = ctx.placeExitLeg(intentId, {
          leg: 'tp',
          attempt: rec.tpAttempt,
          type: 'limit',
          price: cmd.price,
          qty: rec.entryQty,
        })
      }
      // `close` never arises from a tick — SL/TP fills route via onOrderUpdate, deadline via onEvent.
    }
  }

  return {
    kind: 'sl_tp_deadline_retracement_funding_event',

    arm(intent, config, ctx): number {
      if (intent.settleTs === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' has no settleTs to arm against`)
      }
      if (intent.entryFillPx === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' has no entryFillPx for the SL`)
      }
      if (intent.anchorPrice === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' has no anchorPrice for the tracker`)
      }
      if (config.fundingFeeTimeoutSeconds === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' config has no fundingFeeTimeoutSeconds`)
      }
      if (config.slMultiplier === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' config has no slMultiplier`)
      }
      if (config.deadlineSeconds === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' config has no deadlineSeconds`)
      }
      if (config.retracementPct === undefined) {
        throw new Error(`RETRACEMENT_HANDLER: intent '${intent.intentId}' config has no retracementPct`)
      }
      const entryQty = intent.entryFillQty ?? intent.entryQty
      // SL stop-market, active immediately from entry fill (`03` §2 step 2).
      const slCoid = ctx.placeExitLeg(intent.intentId, {
        leg: 'sl',
        attempt: 1,
        type: 'stop',
        price: slTriggerPrice(intent.entryFillPx, config.thresholdPercent, config.slMultiplier),
        qty: entryQty,
      })
      // Deadline keyed to T_settle (recovery reuses the persisted instant), gate arms the tracker.
      const deadlineMs = intent.deadlineMs ?? intent.settleTs + config.deadlineSeconds * 1000
      ctx.scheduleDeadline(intent.intentId, deadlineMs)
      gate.arm({
        intentId: intent.intentId,
        symbol: intent.symbol,
        settleTs: intent.settleTs,
        timeoutSeconds: config.fundingFeeTimeoutSeconds,
      })
      records.set(intent.intentId, {
        tracker: createTrackerState(intent.anchorPrice, config.retracementPct),
        symbol: intent.symbol,
        entryQty,
        slCoid,
        tpAttempt: 0,
      })
      return deadlineMs
    },

    onEvent(event, intent, _config, ctx): undefined {
      const rec = records.get(intent.intentId)
      if (rec === undefined) return undefined
      if (event.type === 'FundingFeeAccrued' && event.symbol === intent.symbol) {
        // Forward the matched WS fee into the gate; the gate's close arms the tracker via the observer.
        gate.onFundingFee(event)
        return undefined
      }
      if (event.type === 'MarketTick' && event.symbol === intent.symbol) {
        const { state, commands } = retracementReduce(rec.tracker, { kind: 'tick', px: event.price, nowMs: event.ts })
        rec.tracker = state
        applyTrailingCommands(intent.intentId, rec, commands, ctx)
        return undefined
      }
      if (event.type === 'Timer' && event.kind === 'deadline' && event.intentId === intent.intentId) {
        const { state, commands } = retracementReduce(rec.tracker, { kind: 'deadline' })
        rec.tracker = state
        // Deadline close: fire the market reduce-only; the resting SL/TP are swept on `→ CLOSED`.
        for (const cmd of commands) if (cmd.kind === 'close') ctx.requestExit(intent.intentId, cmd.exitReason)
        records.delete(intent.intentId)
        return undefined
      }
      return undefined
    },

    onOrderUpdate(event, intent, _config, ctx): void {
      const rec = records.get(intent.intentId)
      if (rec === undefined || event.status !== 'FILLED') return
      const leg = event.clientOrderId === rec.slCoid ? 'sl' : event.clientOrderId === rec.tpCoid ? 'tp' : undefined
      if (leg === undefined) return // an update on a since-cancelled leg — ignore
      const { state, commands } = retracementReduce(rec.tracker, { kind: 'fill', leg })
      rec.tracker = state
      // OCO close: the fill already flattened; `confirmClose` records CLOSED and sweeps the sibling.
      for (const cmd of commands) {
        if (cmd.kind === 'close') ctx.confirmClose(intent.intentId, cmd.exitReason, event.clientOrderId)
      }
      records.delete(intent.intentId)
    },

    dispose(): void {
      gate.dispose()
    },

    serialize(): RetracementSnapshot[] {
      return [...records.entries()].map(([intentId, r]) => ({
        intentId,
        tracker: r.tracker,
        symbol: r.symbol,
        entryQty: r.entryQty,
        tpAttempt: r.tpAttempt,
        ...(r.slCoid !== undefined ? { slCoid: r.slCoid } : {}),
        ...(r.tpCoid !== undefined ? { tpCoid: r.tpCoid } : {}),
      }))
    },

    restore(snapshots): void {
      for (const s of snapshots) {
        records.set(s.intentId, {
          tracker: s.tracker,
          symbol: s.symbol,
          entryQty: s.entryQty,
          tpAttempt: s.tpAttempt,
          slCoid: s.slCoid,
          tpCoid: s.tpCoid,
        })
      }
    },
  }
}
