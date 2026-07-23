/**
 * Entry sub-machine seam (`07_strategy_6.md` §2/§3) — pure core. The analogue of the
 * exit-policy seam ({@link ../intent/exit-policy.ts}) for the **entry** side.
 *
 * The engine's built-in entry is single-direction: one order at `entrySide`, fill → MONITORING.
 * S6 does not fit that model — its entry is a multi-step sub-machine (a tiny opposite-direction
 * PRE_FUNDING order to subscribe the private WS, a funding-gate-triggered MAIN reversal fired
 * once under a lock, an abort ladder, and a REST net-qty confirm) spanning `SUBMITTING_ENTRY`
 * entirely. Rather than branch the engine on strategy name, a strategy module may declare an
 * {@link EntrySubMachineFactory}; presence of the marker switches the engine's `SUBMITTING_ENTRY`
 * handling to the sub-machine (exactly as `entryPlan` switches the ladder path), delegating
 * through the {@link EntryContext} order-command seam. Every other strategy stays byte-unchanged.
 *
 * The engine owns placement, WAL, and the FSM transitions; the sub-machine owns only the entry
 * *choreography* (which order to place when, the funding gate that fires MAIN, the abort ladder).
 * All order/state effects flow back through {@link EntryContext}, mirroring how the exit policy
 * commands the engine through {@link ../intent/exit-policy.ts}.ExitPolicyContext.
 */

import type { FundingFeeAccrued, OrderUpdate } from '../events/types.js'
import type { ErrorCode } from '../intent/intent-machine.js'
import type { Position, Side } from '../ports/exchange-adapter.js'
import type { OpsEvent } from './engine.js'

/**
 * The port subset the entry sub-machine commands the engine through — the entry-side analogue
 * of `ExitPolicyContext`. The engine assigns deterministic client order ids, registers the
 * legs, WALs the transitions, and owns the intent FSM; the sub-machine only says *what* to do.
 */
export interface EntryContext {
  /**
   * Place the tiny PRE_FUNDING market order at `exitSide` (opposite the managed direction),
   * **not** reduce-only — it opens the position that subscribes the symbol to the private WS
   * (`07` §2 step 1). Returns the assigned client order id.
   */
  placePreFunding(intentId: string, qty: number): string
  /** Place the MAIN market order at `entrySide` (the managed direction), reversing the net position (`07` §2 step 3). */
  placeMain(intentId: string, qty: number): string
  /**
   * Fire one reduce-only market close of `qty` for the abort ladder (`07` §2 step 2). Fire-and-forget:
   * the ladder is driven by REST ground truth ({@link getPositions}), not this order's own update.
   */
  placeAbortClose(intentId: string, attempt: number, qty: number): void
  /** REST ground truth for the net-qty confirm + the abort ladder (`07` §2 step 4 / step 2). */
  getPositions(): Promise<readonly Position[]>
  /**
   * Adopt the confirmed net position and advance `SUBMITTING_ENTRY → MONITORING` (`07` §2 step 4).
   * `netQty` is the reduce-only exit cap; `entryPx` is the MAIN fill the OCO geometry anchors on.
   */
  enterMonitoring(intentId: string, netQty: number, entryPx: number): void
  /** Terminate the entry from `SUBMITTING_ENTRY` with `errorCode` (→ `ENTRY_FAILED` or `NO_POSITION`, `07` §3). */
  failEntry(intentId: string, errorCode: ErrorCode): void
  /** Surface a diagnostic ops event (`strategy6.*`) — the engine forwards it to its ops sink. */
  emitOps(event: OpsEvent): void
}

/** Everything the engine hands the sub-machine to begin one intent's entry choreography. */
export interface EntryBegin {
  readonly intentId: string
  readonly symbol: string
  /** `T_settle`, epoch ms UTC — the funding gate's anchor. */
  readonly settleTs: number
  /** Gate timeout past `T_settle`, seconds (`fundingFeeTimeoutSeconds`). */
  readonly timeoutSeconds: number
  /** PRE_FUNDING size (min feasible qty). */
  readonly preQty: number
  /** MAIN size (`mainAmountUsd / price`, lot-floored). */
  readonly mainQty: number
  /** Reduce-only side for the abort ladder = the managed `entrySide`/`mainSide` (closes the opposite PRE leg). */
  readonly abortCloseSide: Side
}

/**
 * One strategy's entry sub-machine (S6). The engine drives it: {@link begin} on entry, then
 * {@link onOrderUpdate} for each PRE/MAIN order update and {@link onFundingFee} for each
 * `funding_fee` event routed while any of its intents is in `SUBMITTING_ENTRY`.
 */
export interface EntrySubMachine {
  /** Start one intent's entry: place PRE, arm the funding gate (`07` §2 step 1/2). */
  begin(begin: EntryBegin, ctx: EntryContext): void
  /** React to a PRE/MAIN order update (fill/reject/fail) for `intentId` (`07` §2 step 1/3). */
  onOrderUpdate(event: OrderUpdate, intentId: string, ctx: EntryContext): void
  /** Feed a `funding_fee` event into the gate — the trigger that fires MAIN (`07` §2 step 3). */
  onFundingFee(event: FundingFeeAccrued, ctx: EntryContext): void
  /** Release the gate's timers on engine shutdown. */
  dispose(): void
}

/**
 * The module marker: a nullary factory the engine invokes once to instantiate the sub-machine
 * (so each engine gets its own gate + per-intent state). Gate ports (clock + funding-income poll)
 * are captured by the factory at composition time — the engine supplies no gate deps.
 */
export type EntrySubMachineFactory = () => EntrySubMachine
