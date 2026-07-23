/**
 * Intent finite-state machine (`12_strategy_runtime_and_intent_lifecycle.md` §5),
 * built on the shared engine ({@link ./fsm-engine.ts}, `08` §5).
 *
 * One intent = one strategy attempt on one symbol for one settlement. Terminal
 * states carry exactly one canonical registry value (`00_globals.md` §10, R12):
 * `CLOSED` (position existed and was closed) carries an {@link ExitReason};
 * `ABORTED` / `ENTRY_FAILED` / `NO_POSITION` (terminated without a managed
 * position) carry an {@link ErrorCode}. {@link transitionIntent} enforces that
 * rule; the generic engine stays payload-opaque.
 */

import { defineMachine } from './fsm-engine.js'

/** The eight intent states (`12` §5 diagram + table). */
export type IntentState =
  | 'SELECTED'
  | 'SUBMITTING_ENTRY'
  | 'MONITORING'
  | 'EXITING'
  | 'CLOSED'
  | 'ABORTED'
  | 'ENTRY_FAILED'
  | 'NO_POSITION'

/**
 * Legal transitions (`12` §5).
 *
 * `NO_POSITION` is reachable from **both** `SUBMITTING_ENTRY` and `MONITORING`:
 * the §5 ASCII diagram draws the arrow only off the `MONITORING` column, but the
 * prose contradicts a `MONITORING`-only source — `NO_POSITION`'s error codes
 * (`00_globals.md` §10.2) include `limit_expired` / `ladder_no_fills`, which are
 * entry-order outcomes (`SUBMITTING_ENTRY`, where "ladders manage N rung
 * orders"), and S6's entry sub-machine spans `SUBMITTING_ENTRY` / `MONITORING`
 * with its codes "plugging into `NO_POSITION`" from either phase. Recorded as an
 * assumption in `docs/plan/STATUS.md` (spec-text-supported, flagged for review).
 */
const INTENT_TRANSITIONS = {
  SELECTED: ['SUBMITTING_ENTRY', 'ABORTED'],
  SUBMITTING_ENTRY: ['MONITORING', 'ENTRY_FAILED', 'NO_POSITION'],
  MONITORING: ['EXITING', 'NO_POSITION'],
  EXITING: ['CLOSED'],
  CLOSED: [],
  ABORTED: [],
  ENTRY_FAILED: [],
  NO_POSITION: [],
} as const satisfies { readonly [S in IntentState]: readonly IntentState[] }

/**
 * The terminal intent states (no outgoing transitions), derived from the one
 * transition table so there is a single source of truth. The Postgres `Repo`
 * (0080) uses this to select non-terminal intents for crash recovery (`14` §7)
 * rather than redefining the set.
 */
export const TERMINAL_INTENT_STATES: readonly IntentState[] = (
  Object.keys(INTENT_TRANSITIONS) as readonly IntentState[]
).filter((state) => INTENT_TRANSITIONS[state].length === 0)

/**
 * `exit_reason` — a position existed and was closed (`00_globals.md` §10.1).
 * Single-sourced as an `as const` array so the Postgres `exit_reason` pg-enum
 * (`db/schema.ts`) and the drift guard (`enum-parity.test.ts`) share one list.
 */
export const EXIT_REASONS = [
  'timed',
  'funding_fee_event',
  'funding_fee_timeout',
  'tp_hit',
  'sl_hit',
  'deadline',
  'kill_switch_flatten',
] as const
export type ExitReason = (typeof EXIT_REASONS)[number]

/**
 * `error_code` — intent terminated without a managed position (`00_globals.md`
 * §10.2). Single-sourced as an `as const` array (see {@link EXIT_REASONS}).
 */
export const ERROR_CODES = [
  // any-strategy / recovery outcomes
  'kill_switch',
  'limit_expired',
  'ladder_no_fills',
  // preflight risk gate + balance/account checks (task 0140, `12` §3 / `13` §1)
  'risk_max_concurrent_intents',
  'risk_max_notional_usd',
  'risk_breaker_open',
  'insufficient_balance',
  'account_setup_incomplete',
  // S6 entry state machine (`07_strategy_6.md` §3)
  'pre_funding_order_failed',
  'pre_funding_order_rejected',
  'pre_funding_not_filled',
  'funding_event_timeout',
  'main_order_failed',
  'main_order_rejected',
  'close_pre_funding_failed',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Terminal states reached with a position closed. */
export type ExitReasonState = 'CLOSED'
/** Terminal states reached without a managed position. */
export type ErrorCodeState = 'ABORTED' | 'ENTRY_FAILED' | 'NO_POSITION'

/**
 * The payload carried on every intent transition, discriminated on the presence
 * of `exitReason` vs `errorCode` (R12: exactly one on a terminal path). Non-
 * terminal transitions carry neither.
 */
export type IntentTerminalPayload =
  | { readonly exitReason?: undefined; readonly errorCode?: undefined }
  | { readonly exitReason: ExitReason; readonly errorCode?: undefined }
  | { readonly errorCode: ErrorCode; readonly exitReason?: undefined }

export const intentMachine = defineMachine<typeof INTENT_TRANSITIONS, IntentTerminalPayload>({
  name: 'intent',
  transitions: INTENT_TRANSITIONS,
})

/** States requiring an `exitReason` on entry. */
const EXIT_REASON_STATES = new Set<IntentState>(['CLOSED'])
/** States requiring an `errorCode` on entry. */
const ERROR_CODE_STATES = new Set<IntentState>(['ABORTED', 'ENTRY_FAILED', 'NO_POSITION'])

/**
 * Transition an intent, enforcing R12 on terminal targets on top of the engine's
 * legal-transition check: `→ CLOSED` requires `exitReason` (and no `errorCode`);
 * `→ ABORTED` / `ENTRY_FAILED` / `NO_POSITION` requires `errorCode` (and no
 * `exitReason`). Throws on violation. The engine remains payload-opaque; this
 * wrapper owns the closed-union rule.
 */
export function transitionIntent<From extends IntentState>(
  from: From,
  to: (typeof INTENT_TRANSITIONS)[From][number],
  payload: IntentTerminalPayload,
): IntentTerminalPayload {
  const result = intentMachine.transition(from, to, payload)
  if (EXIT_REASON_STATES.has(to)) {
    if (result.exitReason === undefined) {
      throw new Error(`[intent] transition to ${to} requires an exitReason (00_globals §10.1)`)
    }
    if (result.errorCode !== undefined) {
      throw new Error(`[intent] transition to ${to} must not carry an errorCode (R12)`)
    }
  }
  if (ERROR_CODE_STATES.has(to)) {
    if (result.errorCode === undefined) {
      throw new Error(`[intent] transition to ${to} requires an errorCode (00_globals §10.2)`)
    }
    if (result.exitReason !== undefined) {
      throw new Error(`[intent] transition to ${to} must not carry an exitReason (R12)`)
    }
  }
  return result
}
