/**
 * Strategy 6 entry sub-machine (`07_strategy_6.md` §2/§3) — pure core. The most elaborate entry
 * in the fleet, and the only one implemented as its own FSM behind the {@link ../../runtime/entry-submachine.ts}
 * seam. It spans `SUBMITTING_ENTRY` entirely (MONITORING begins only after the MAIN fill + net confirm),
 * so **all seven** S6 error terminals fire from here.
 *
 * The choreography, per intent:
 *   PLACING_PRE → AWAIT_GATE → PLACING_MAIN → CONFIRMING → (MONITORING | terminal)
 *
 *  1. `begin`: place the tiny opposite-direction PRE_FUNDING market order (subscribes the private WS)
 *     and arm a per-intent {@link ../../runtime/funding-gate.ts}.FundingGate.
 *  2. PRE update: FILLED ⇒ armed and waiting; REJECTED/FAILED ⇒ `pre_funding_order_rejected/failed`.
 *  3. Gate `GateOpened` (WS `funding_fee` within ±5 s, or the REST safety-net poll): under a once-only
 *     {@link mainFired} lock (belt-and-suspenders atop the gate's own idempotency), confirm PRE actually
 *     filled (else abort-close the partial → `pre_funding_not_filled`) and fire the MAIN reversal.
 *  4. Gate `GateClosed{timeout}`: no funding event in time ⇒ abort-ladder the PRE leg → `funding_event_timeout`.
 *  5. MAIN update: REJECTED/FAILED ⇒ abort-ladder the PRE leg → `main_order_rejected/failed`; FILLED ⇒
 *     REST `getPositions()` net confirm (on throw: `strategy6.position_fetch_fallback`, use tracked
 *     `mainQty − preQty`) → `enterMonitoring`.
 *  6. Any abort that cannot flatten after all retries ⇒ `strategy6.close_pre_funding_failed` +
 *     `close_pre_funding_failed` (orphan risk; the orphan auto-flatten backstop is `00_globals.md` §5.3).
 *
 * Gate/state is in-memory only; a durable snapshot + boot-respawn is 0370.
 */

import type { FundingFeeAccrued, OrderUpdate } from '../../events/types.js'
import type { ErrorCode } from '../../intent/intent-machine.js'
import type { Clock } from '../../ports/clock.js'
import { closeWithRetries } from '../../runtime/close-with-retries.js'
import type { EntryBegin, EntryContext, EntrySubMachine } from '../../runtime/entry-submachine.js'
import {
  createFundingGate,
  type FundingGate,
  type FundingIncomePoll,
  type GateSignal,
} from '../../runtime/funding-gate.js'

/** Abort-ladder backoff schedule (`07` §2 step 2): 3 retries at 250 / 1000 / 3000 ms. */
const ABORT_BACKOFFS_MS: readonly number[] = [250, 1000, 3000]

/** The gate ports the sub-machine injects into its funding gate (mirrors `FundingFeeEventDeps`). */
export interface Strategy6EntryDeps {
  readonly clock: Clock
  readonly fundingIncome: FundingIncomePoll
}

/** One intent's phase in the entry choreography (`07` §2). */
type Phase = 'PLACING_PRE' | 'AWAIT_GATE' | 'PLACING_MAIN' | 'ABORTING' | 'CONFIRMING'

/** Per-intent sub-state. Order routing is by {@link phase} (not client-order-id), so a synchronous sim fill is safe. */
interface SubState extends EntryBegin {
  phase: Phase
  preFilled: boolean
  preFillPx?: number
}

/** Build the S6 entry sub-machine, owning one shared funding gate (keyed per-intent). */
export function createStrategy6EntrySubMachine(deps: Strategy6EntryDeps): EntrySubMachine {
  const states = new Map<string, SubState>()
  /** Once-only MAIN lock (`07` §2 step 3): guards MAIN placement even if the gate double-fired. */
  const mainFired = new Set<string>()
  // The engine binds one `EntryContext`; capture it on the first `begin` so the gate observer (which
  // resolves out of band on an async poll / gate-owned timer) can command the engine.
  let capturedCtx: EntryContext | undefined

  const gate: FundingGate = createFundingGate({
    clock: deps.clock,
    poll: deps.fundingIncome,
    observer: (signal) => onGateSignal(signal),
  })

  /** Map an S6 error code to its terminal (order-outcome → ENTRY_FAILED; position-outcome → NO_POSITION) is the engine's job. */
  function fail(state: SubState, ctx: EntryContext, code: ErrorCode): void {
    ctx.failEntry(state.intentId, code)
    states.delete(state.intentId)
  }

  /**
   * Abort ladder then terminate. Flatten the PRE leg by REST ground truth; on success terminate with
   * `successCode`, on exhaustion surface the orphan-risk ops event + `close_pre_funding_failed` (`07` §3).
   */
  async function abortThenFail(state: SubState, ctx: EntryContext, successCode: ErrorCode): Promise<void> {
    state.phase = 'ABORTING'
    const result = await closeWithRetries({
      symbol: state.symbol,
      closeSide: state.abortCloseSide,
      backoffsMs: ABORT_BACKOFFS_MS,
      clock: deps.clock,
      placeClose: (attempt, qty) => ctx.placeAbortClose(state.intentId, attempt, qty),
      groundTruthFetch: () => ctx.getPositions(),
    })
    if (!states.has(state.intentId)) return // disposed / raced terminal
    if (result.closed) {
      fail(state, ctx, successCode)
      return
    }
    ctx.emitOps({ kind: 'strategy6.close_pre_funding_failed', intentId: state.intentId, symbol: state.symbol })
    fail(state, ctx, 'close_pre_funding_failed')
  }

  /** REST net-qty confirm after the MAIN fill, then `enterMonitoring` (`07` §2 step 4). */
  async function confirmAndMonitor(state: SubState, ctx: EntryContext, mainFillPx: number): Promise<void> {
    const tracked = state.mainQty - state.preQty
    let netQty = tracked
    try {
      const positions = await ctx.getPositions()
      if (!states.has(state.intentId)) return
      netQty = positions.find((p) => p.symbol === state.symbol)?.qty ?? tracked
    } catch {
      if (!states.has(state.intentId)) return
      // REST confirm failed — fall back to tracked fills, warn (normative, `07` §2 step 4).
      ctx.emitOps({ kind: 'strategy6.position_fetch_fallback', intentId: state.intentId, symbol: state.symbol })
    }
    if (!states.has(state.intentId)) return
    ctx.enterMonitoring(state.intentId, netQty, mainFillPx)
    states.delete(state.intentId)
  }

  /** Gate signal handler — fires MAIN on open, aborts on timeout (`07` §2 step 3/2). */
  function onGateSignal(signal: GateSignal): void {
    const ctx = capturedCtx
    if (ctx === undefined) return
    const state = states.get(signal.intentId)
    if (state === undefined) return
    if (signal.type === 'GateOpened') {
      if (mainFired.has(state.intentId)) return // once-only MAIN lock
      mainFired.add(state.intentId)
      if (!state.preFilled) {
        // WS event arrived but PRE never confirmed filled — abort the (possibly partial) leg.
        void abortThenFail(state, ctx, 'pre_funding_not_filled')
        return
      }
      state.phase = 'PLACING_MAIN'
      ctx.placeMain(state.intentId, state.mainQty) // synchronous sim fill routes back via onOrderUpdate
      return
    }
    // GateClosed: only `timeout` is actionable here (`opened` trails a GateOpened we already handled).
    if (signal.reason === 'timeout') void abortThenFail(state, ctx, 'funding_event_timeout')
  }

  return {
    begin(begin: EntryBegin, ctx: EntryContext): void {
      capturedCtx = ctx
      states.set(begin.intentId, { ...begin, phase: 'PLACING_PRE', preFilled: false })
      // Place PRE first: the sim fills a market order synchronously, so its FILLED update routes back
      // through onOrderUpdate (phase PLACING_PRE) before this call returns, flipping us to AWAIT_GATE.
      ctx.placePreFunding(begin.intentId, begin.preQty)
      // Arm the gate only if PRE didn't synchronously reject (which would have deleted the state).
      if (states.has(begin.intentId)) {
        gate.arm({
          intentId: begin.intentId,
          symbol: begin.symbol,
          settleTs: begin.settleTs,
          timeoutSeconds: begin.timeoutSeconds,
        })
      }
    },

    onOrderUpdate(event: OrderUpdate, intentId: string, ctx: EntryContext): void {
      capturedCtx = ctx
      const state = states.get(intentId)
      if (state === undefined) return
      if (state.phase === 'PLACING_PRE') {
        if (event.status === 'FILLED') {
          state.preFilled = true
          state.preFillPx = event.fillPx
          state.phase = 'AWAIT_GATE'
        } else if (event.status === 'REJECTED' || event.status === 'FAILED') {
          fail(state, ctx, event.status === 'REJECTED' ? 'pre_funding_order_rejected' : 'pre_funding_order_failed')
        }
        return
      }
      if (state.phase === 'PLACING_MAIN') {
        if (event.status === 'FILLED') {
          state.phase = 'CONFIRMING'
          void confirmAndMonitor(state, ctx, event.fillPx ?? state.preFillPx ?? 0)
        } else if (event.status === 'REJECTED' || event.status === 'FAILED') {
          void abortThenFail(state, ctx, event.status === 'REJECTED' ? 'main_order_rejected' : 'main_order_failed')
        }
      }
    },

    onFundingFee(event: FundingFeeAccrued, ctx: EntryContext): void {
      capturedCtx = ctx
      gate.onFundingFee(event)
    },

    dispose(): void {
      gate.dispose()
    },
  }
}
